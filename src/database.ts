import { monotonicUlid } from "@std/ulid";
import type {
  KrvAnyKey,
  KrvAnyLiterals,
  KrvCommitResult,
  KrvDeleteOptions,
  KrvEntry,
  KrvEntryMaybe,
  KrvExpand,
  KrvExpanded,
  KrvExpandNoClash,
  KrvExpandSpec,
  KrvFieldAt,
  KrvGetOptions,
  KrvInputAt,
  KrvInputAtLiterals,
  KrvInsertOptions,
  KrvKey,
  KrvKeyPart,
  KrvListOptions,
  KrvListResult,
  KrvPatch,
  KrvRowKeyAtLiterals,
  KrvSetOptions,
  KrvTableAtKey,
  KrvTableAtLiterals,
  KrvTables,
  KrvUpdateOptions,
  KrvValueAt,
  KrvValueAtLiterals,
  KrvValuesResult,
  KrvWhereAtLiterals,
} from "./types/main.ts";
import {
  KrvConflictError,
  KrvNotFoundError,
  KrvReferenceError,
  KrvValidationError,
} from "./errors.ts";
import { backoff, commitWithLockRetry } from "./commit.ts";
import { WriteBatch } from "./batch.ts";
import {
  type createRegistry,
  guardKey,
  indexKey,
  indexPrefix,
  INTERNAL,
  isKeyPart,
  keyId,
  keysEqual,
  keyToString,
  type ParsedIndex,
  type ParsedTable,
  type Reference,
  secondaryPrefix,
  uniqueKey,
} from "./registry.ts";
import {
  deepEqual,
  loadRow,
  matchesWhere,
  mergePatch,
  saveRow,
  saveWhereValue,
} from "./values.ts";

/** Retries after a conflict caused by a concurrent write between our read and commit. */
const MAX_CONFLICT_RETRIES = 50;
/** Deno KV's getMany limit. */
const GET_MANY_LIMIT = 10;

type Row = Record<string, unknown>;
type Registry = ReturnType<typeof createRegistry>;

/** The open `Deno.Kv`. Replaced while migrations take and restore backups. */
export type DatabaseState = { kv: Deno.Kv };

/**
 * The typed read/write API over a registry. `Tables` and `E` (validators and
 * transforms) only drive the types.
 */
export const createDatabase = <Tables extends KrvTables, E>(
  state: DatabaseState,
  registry: Registry,
) => {
  const validate = (table: ParsedTable, row: Row, skip: Set<string>) => {
    const issues = table.schema.checkExcept(row, table.name, skip);
    if (issues.length) throw new KrvValidationError(issues);
  };

  /**
   * Fills what the caller may leave out: key fields from `key`, generated
   * fields from the current row or a new ULID, and timestamps.
   */
  const fill = (
    table: ParsedTable,
    value: Row,
    key: KrvKey | null,
    current: Row | null,
    now: number,
  ): Row => {
    const row = { ...value };
    if (key) {
      table.pattern.forEach((part, i) => {
        if (!("placeholder" in part)) return;
        const field = table.bindings[part.placeholder];
        if (row[field] === undefined) row[field] = key[i];
      });
    }
    for (const field of table.generated) {
      if (row[field] === undefined) {
        row[field] = current?.[field] ?? monotonicUlid();
      }
    }
    if (table.timestamps) {
      row.createdAt ??= current?.createdAt ?? now;
      // Unchanged from what's stored (e.g. a spread row): it's not an override.
      if (row.updatedAt === undefined || row.updatedAt === current?.updatedAt) {
        row.updatedAt = now;
      }
    }
    return row;
  };

  /** Makes sure the row `target` exists, or is being written in this batch. */
  const assertTarget = async (
    batch: WriteBatch,
    table: ParsedTable,
    reference: Reference,
    target: KrvKey,
  ) => {
    const pending = batch.pending(target);
    if (pending === "set") return;
    const entry = pending === "delete" ? null : await state.kv.get(target);
    if (!entry || entry.versionstamp === null) {
      throw new KrvReferenceError(
        `${table.name}.${reference.field}: ${
          keyToString(target)
        } does not exist`,
      );
    }
    batch.check(target, entry.versionstamp);
  };

  /** Adds `row`'s secondary index entries (replacing `oldRow`'s) to `batch`. */
  const planIndexes = async (
    batch: WriteBatch,
    table: ParsedTable,
    oldKey: KrvKey | null,
    oldRow: Row | null,
    key: KrvKey,
    row: Row,
    expireIn: number | undefined,
  ) => {
    const moved = oldKey !== null && !keysEqual(oldKey, key);
    for (const index of table.indexes) {
      const before = oldRow
        ? await registry.indexValues(table, index, oldRow)
        : null;
      const after = await registry.indexValues(table, index, row);
      const same = before && after && keysEqual(before, after);
      if (same && !moved) continue;

      if (before) removeIndex(batch, table, index, before, oldKey!);
      if (!after) continue;

      if (index.unique) {
        const unique = uniqueKey(table.name, index.name, after);
        const taken = await state.kv.get<KrvKey>(unique);
        const owner = taken.value;
        if (
          owner && !keysEqual(owner, key) &&
          !(oldKey && keysEqual(owner, oldKey)) &&
          batch.pending(owner) !== "delete"
        ) {
          throw new KrvConflictError(
            key,
            `${table.name}.${index.name}: ${
              index.fields.join(", ")
            } already taken by ${keyToString(owner)} (unique)`,
          );
        }
        batch.check(unique, taken.versionstamp);
        batch.set(unique, key, expireIn, true);
      } else {
        batch.set(
          [...secondaryPrefix(table.name, index.name, after), ...key],
          null,
          expireIn,
          true,
        );
      }
    }
  };

  const removeIndex = (
    batch: WriteBatch,
    table: ParsedTable,
    index: ParsedIndex,
    values: KrvKeyPart[],
    key: KrvKey,
  ) => {
    if (index.unique) batch.delete(uniqueKey(table.name, index.name, values));
    else {
      batch.delete([
        ...secondaryPrefix(table.name, index.name, values),
        ...key,
      ]);
    }
  };

  /**
   * Adds writing `row` (stored values) to `batch`: the row itself, its
   * indexes and, when its key changes, the rows referencing it (which may
   * move in turn).
   */
  const planWrite = async (
    batch: WriteBatch,
    table: ParsedTable,
    oldKey: KrvKey | null,
    oldRow: Row | null,
    row: Row,
    expireIn: number | undefined,
    visited: Set<string>,
    now: number,
  ) => {
    const key = registry.rowKey(table, row);
    visited.add(keyId(key));
    const moved = oldKey !== null && !keysEqual(oldKey, key);

    if (moved) {
      if (batch.pending(key) !== "delete") {
        const existing = await state.kv.get(key);
        if (existing.versionstamp !== null) {
          throw new KrvConflictError(
            key,
            `Can't move ${keyToString(oldKey)} to ${
              keyToString(key)
            }: it already exists`,
          );
        }
        batch.check(key, null);
      }
      batch.delete(oldKey);
    }
    batch.set(key, row, expireIn, true);

    await planIndexes(batch, table, oldKey, oldRow, key, row, expireIn);

    // Outgoing references.
    for (const reference of table.references) {
      const before = oldRow ? registry.targetKey(reference, oldRow) : null;
      const after = registry.targetKey(reference, row);
      const sameTarget = before && after && keysEqual(before, after);
      if (sameTarget && !moved) continue;

      if (before) {
        batch.delete(indexKey(table.name, reference.field, before, oldKey!));
        batch.set(guardKey(before), null);
      }
      if (after) {
        if (!sameTarget) await assertTarget(batch, table, reference, after);
        batch.set(
          indexKey(table.name, reference.field, after, key),
          null,
          expireIn,
        );
        batch.set(guardKey(after), null);
      }
    }

    // Incoming references: follow the row to its new key.
    if (!moved || table.incoming.length === 0) return;

    const guard = guardKey(oldKey);
    const guardEntry = await state.kv.get(guard);
    batch.check(guard, guardEntry.versionstamp);
    batch.delete(guard);

    for (const { source, reference } of table.incoming) {
      const prefix = indexPrefix(source.name, reference.field, oldKey);
      for await (const entry of state.kv.list({ prefix })) {
        const childKey = entry.key.slice(prefix.length);
        if (visited.has(keyId(childKey))) continue;

        const child = await state.kv.get<Row>(childKey);
        if (child.versionstamp === null) {
          batch.delete(entry.key); // stale index entry
          continue;
        }
        batch.check(childKey, child.versionstamp);

        const updated = { ...child.value };
        for (const [placeholder, field] of Object.entries(reference.fields)) {
          updated[field] = row[table.bindings[placeholder]];
        }
        if (source.timestamps) updated.updatedAt = now;
        await planWrite(
          batch,
          source,
          childKey,
          child.value,
          updated,
          undefined,
          visited,
          now,
        );
      }
    }
  };

  /**
   * Adds deleting `key` to `batch`. Rows referencing it are deleted too when
   * `cascade` is set; otherwise their existence throws.
   */
  const planDelete = async (
    batch: WriteBatch,
    table: ParsedTable,
    key: KrvKey,
    row: Row,
    cascade: boolean,
    visited: Set<string>,
  ) => {
    if (visited.has(keyId(key))) return;
    visited.add(keyId(key));
    batch.delete(key);

    for (const index of table.indexes) {
      const values = await registry.indexValues(table, index, row);
      if (values) removeIndex(batch, table, index, values, key);
    }

    for (const reference of table.references) {
      const target = registry.targetKey(reference, row);
      if (!target) continue;
      batch.delete(indexKey(table.name, reference.field, target, key));
      batch.set(guardKey(target), null);
    }

    if (table.incoming.length === 0) return;

    const guard = guardKey(key);
    const guardEntry = await state.kv.get(guard);
    batch.check(guard, guardEntry.versionstamp);
    batch.delete(guard);

    for (const { source, reference } of table.incoming) {
      const prefix = indexPrefix(source.name, reference.field, key);
      for await (const entry of state.kv.list({ prefix })) {
        const childKey = entry.key.slice(prefix.length);
        if (!cascade) {
          throw new KrvReferenceError(
            `Can't delete ${keyToString(key)}: referenced by ${
              keyToString(childKey)
            } (${source.name}.${reference.field}). ` +
              `Pass { cascade: true } to delete it too.`,
          );
        }

        const child = await state.kv.get<Row>(childKey);
        if (child.versionstamp === null) {
          batch.delete(entry.key); // stale index entry
          continue;
        }
        await planDelete(
          batch,
          source,
          childKey,
          child.value,
          cascade,
          visited,
        );
      }
    }
  };

  /**
   * Validates, transforms and writes `value` at `key`.
   * @returns The commit result and the row as validated (plain values).
   */
  const write = async (
    key: KrvKey,
    value: Row,
    options: KrvSetOptions,
  ): Promise<{ result: KrvCommitResult; row: Row; stored: Row }> => {
    const table = registry.resolveKey(key);
    const { check, expireIn } = options;

    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await backoff(attempt);

      const current = await state.kv.get<Row>(key);
      if (check !== undefined && current.versionstamp !== check) {
        throw new KrvConflictError(key);
      }

      // Opaque fields (e.g. hashes) passed back unchanged are kept as stored.
      const keep = new Set(
        [...table.opaque].filter((field) =>
          current.value && value[field] !== undefined &&
          deepEqual(value[field], current.value[field])
        ),
      );

      const now = Date.now();
      const row = fill(table, value, key, current.value, now);
      validate(table, row, keep);

      const exists = current.versionstamp !== null;
      if (!exists && !keysEqual(registry.rowKey(table, row), key)) {
        throw new Error(
          `Key ${keyToString(key)} doesn't match the key fields of the value ` +
            `(${keyToString(registry.rowKey(table, row))})`,
        );
      }

      const stored = await saveRow(table, row, keep);
      const batch = new WriteBatch().check(key, current.versionstamp);
      await planWrite(
        batch,
        table,
        exists ? key : null,
        current.value,
        stored,
        expireIn,
        new Set(),
        now,
      );

      const result = await commitWithLockRetry(() => batch.build(state.kv));
      if (result.ok) return { result, row, stored };
    }

    throw new KrvConflictError(key);
  };

  /** What a write returns: plain values, except opaque fields (as stored). */
  const output = (table: ParsedTable, row: Row, stored: Row): Row => {
    const value = { ...row };
    for (const field of table.opaque) {
      if (stored[field] !== undefined) value[field] = stored[field];
    }
    return value;
  };

  type Expansion =
    | {
      name: string;
      kind: "forward";
      reference: Reference;
      target: ParsedTable;
      nested: Expansion[];
    }
    | {
      name: string;
      kind: "reverse";
      reference: Reference;
      source: ParsedTable;
      single: boolean;
      options: Exclude<KrvExpandSpec, string>;
    };

  /**
   * Resolves `expand` for `table`: `"authorId"` (a reference field of this
   * row) expands forward to one row; `"books.authorId"` (a field of another
   * table referencing this one) expands to a list, or to one row when that
   * table is keyed by the reference (1:1). Throws for anything else.
   */
  const resolveExpand = (
    table: ParsedTable,
    expand: Record<string, KrvExpandSpec> | undefined,
  ): Expansion[] =>
    Object.entries(expand ?? {}).map(([name, spec]) => {
      const options = typeof spec === "string" ? { from: spec } : spec;
      const where = `${table.name}: expand.${name}`;
      if (table.schema.fields.some((f) => f.name === name)) {
        throw new Error(`${where}: "${name}" is already a field of the table`);
      }

      const dot = options.from.lastIndexOf(".");
      if (dot === -1) {
        const reference = table.references.find((r) =>
          r.field === options.from
        );
        if (!reference) {
          throw new Error(
            `${where}: "${options.from}" isn't a reference field of ${table.name}`,
          );
        }
        const target = registry.get(reference.target);
        return {
          name,
          kind: "forward",
          reference,
          target,
          nested: resolveExpand(target, options.expand),
        };
      }

      const source = registry.byName(options.from.slice(0, dot));
      const field = options.from.slice(dot + 1);
      const reference = source?.references.find((r) =>
        r.field === field && r.target === table.name
      );
      if (!source || !reference) {
        throw new Error(
          `${where}: "${options.from}" isn't a field of another table referencing ${table.name}`,
        );
      }
      resolveExpand(source, options.expand); // validate nested now
      const single = table.pattern.length > 0 &&
        source.pattern.every((part) =>
          !("placeholder" in part) ||
          reference.fields[part.placeholder] ===
            source.bindings[part.placeholder]
        );
      return { name, kind: "reverse", reference, source, single, options };
    });

  /** Adds each expansion to `rows` (loaded values), in place. */
  const expandRows = async (
    table: ParsedTable,
    rows: Row[],
    expansions: Expansion[],
    consistency?: Deno.KvConsistencyLevel,
  ): Promise<void> => {
    for (const expansion of expansions) {
      if (expansion.kind === "forward") {
        // Batched: every distinct target of these rows, 10 per read.
        const keys = new Map<string, KrvKey>();
        for (const row of rows) {
          const target = registry.targetKey(expansion.reference, row);
          if (target) keys.set(keyId(target), target);
        }
        const found = new Map<string, Row>();
        const targets: Row[] = [];
        for await (const entry of fetchRows([...keys.values()], consistency)) {
          const value = await loadRow(expansion.target, entry.value);
          found.set(keyId(entry.key), value);
          targets.push(value);
        }
        await expandRows(
          expansion.target,
          targets,
          expansion.nested,
          consistency,
        );
        for (const row of rows) {
          const target = registry.targetKey(expansion.reference, row);
          row[expansion.name] = target
            ? found.get(keyId(target)) ?? null
            : null;
        }
        continue;
      }

      // Reverse: the referencing rows, through the reference's index.
      const { source, reference, single, options } = expansion;
      await Promise.all(rows.map(async (row) => {
        const where: Row = { ...(options.where ?? {}) };
        for (const [placeholder, field] of Object.entries(reference.fields)) {
          where[field] = row[table.bindings[placeholder]];
        }
        const found = await listRows(source.literals, {
          where,
          filter: options.filter as KrvListOptions<Row>["filter"],
          limit: single ? 1 : options.limit,
          reverse: options.reverse,
          consistency,
          expand: options.expand,
        });
        row[expansion.name] = single ? found[0] ?? null : found;
      }));
    }
  };

  /**
   * Reads one row by its full key.
   *
   * @param key Full row key, e.g. `["users", id]`, or `["config"]` for a
   *   static table.
   * @param options `consistency`: `"strong"` (default) or `"eventual"`.
   * @returns The entry, with transforms loaded. `value` and `versionstamp`
   *   are `null` when the row doesn't exist.
   * @throws Error if the key doesn't belong to any table.
   *
   * @example
   * ```ts
   * const user = await db.get(["users", id]);
   * if (user.value) console.log(user.value.name, user.value.createdAt);
   * ```
   */
  const get = (async (
    key: KrvKey,
    options: KrvGetOptions & { expand?: Record<string, KrvExpandSpec> } = {},
  ) => {
    const table = registry.resolveKey(key);
    const expansions = resolveExpand(table, options.expand);
    const entry = await state.kv.get<Row>(key, options);
    if (entry.value === null) return entry;
    const value = await loadRow(table, entry.value);
    await expandRows(table, [value], expansions, options.consistency);
    return { ...entry, value };
  }) as unknown as <
    const Key extends KrvAnyKey<Tables>,
    const X extends Record<string, unknown> = Record<never, never>,
  >(
    key: Key,
    options?:
      & KrvGetOptions
      & {
        expand?:
          & X
          & KrvExpand<Tables, E, KrvTableAtKey<Tables, Key>>
          & NoInfer<KrvExpandNoClash<X, KrvTableAtKey<Tables, Key>, E>>;
      },
  ) => Promise<
    KrvEntryMaybe<
      KrvExpanded<
        Tables,
        E,
        KrvTableAtKey<Tables, Key>,
        KrvValueAt<Tables, E, Key>,
        X
      >,
      Key
    >
  >;

  /**
   * Creates or overwrites a row, in one atomic commit together with its
   * indexes and references.
   *
   * - Key fields left out of `value` are taken from `key`.
   * - `"id"` fields left out keep their current value, or get a new ULID.
   * - `createdAt` keeps its current value; `updatedAt` becomes now. Pass
   *   other values to override them.
   * - Transformed fields are validated as plain values, then saved. Opaque
   *   ones (no `load`, e.g. hashes) passed back unchanged are kept as stored.
   * - If `value` changes a key field, the row **moves** to its new key and
   *   every row referencing it is updated to follow (recursively).
   *
   * @param key Full row key, e.g. `["users", id]`.
   * @param value The row. Validated against the table's schema.
   * @param options
   *   - `check`: only write if the row's current versionstamp matches
   *     (`null`: only if it doesn't exist yet).
   *   - `expireIn`: milliseconds until the row expires.
   * @returns `{ ok: true, versionstamp }`.
   * @throws KrvValidationError if `value` doesn't match the schema.
   * @throws KrvConflictError if `check` fails, a unique index value or the
   *   destination of a move is taken, or concurrent writes keep winning.
   * @throws KrvReferenceError if a reference points at a missing row.
   *
   * @example
   * ```ts
   * await db.set(["users", id], { name: "Pablo" });
   *
   * // Optimistic concurrency: read, modify, write only if unchanged.
   * const current = await db.get(["users", id]);
   * await db.set(["users", id], { ...current.value!, age: 30 }, {
   *   check: current.versionstamp,
   * });
   * ```
   */
  const set =
    (async (key: KrvKey, value: Row, options: KrvSetOptions = {}) =>
      (await write(key, value, options)).result) as unknown as <
        const Key extends KrvAnyKey<Tables>,
      >(
        key: Key,
        value: KrvInputAt<Tables, E, Key>,
        options?: KrvSetOptions,
      ) => Promise<KrvCommitResult>;

  /**
   * Updates part of a row, without reading it first. The patch is merged into
   * the stored row and written in one atomic commit; if another write lands
   * in between, it's merged again on top of that one.
   *
   * - Nested objects merge; arrays and maps (`[]`, `{}`) are replaced whole.
   * - `undefined` removes a field.
   * - A function receives the current row and returns the patch, for updates
   *   based on the current value (it may run more than once).
   * - Everything `set` does applies: validation of the whole row, transforms,
   *   indexes, references, `updatedAt`, and moves when a key field changes.
   *
   * @param key Full row key.
   * @param patch A partial row, or `(row) => partial row`.
   * @param options
   *   - `check`: only update if the row's current versionstamp matches.
   *   - `expireIn`: milliseconds until the row expires.
   * @returns The updated row.
   * @throws KrvNotFoundError if the row doesn't exist.
   * @throws KrvValidationError, KrvConflictError, KrvReferenceError as `set`.
   *
   * @example
   * ```ts
   * await db.update(["notes", id], { done: true });
   * await db.update(["posts", id], (post) => ({ views: post.views + 1 }));
   * ```
   */
  const update = (async (
    key: KrvKey,
    patch: Row | ((row: Row) => Row),
    options: KrvUpdateOptions = {},
  ) => {
    const table = registry.resolveKey(key);
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await backoff(attempt);

      const current = await state.kv.get<Row>(key);
      if (current.versionstamp === null) throw new KrvNotFoundError(key);
      if (
        options.check !== undefined && current.versionstamp !== options.check
      ) {
        throw new KrvConflictError(key);
      }

      const loaded = await loadRow(table, current.value);
      const changes = typeof patch === "function" ? patch(loaded) : patch;
      const merged = mergePatch(table.schema.fields, loaded, changes);
      try {
        const written = await write(key, merged, {
          check: current.versionstamp,
          expireIn: options.expireIn,
        });
        return output(table, written.row, written.stored);
      } catch (error) {
        // Someone wrote the row in between: merge again on top of it.
        const now = await state.kv.get(key);
        if (
          error instanceof KrvConflictError &&
          now.versionstamp !== current.versionstamp &&
          options.check === undefined
        ) continue;
        throw error;
      }
    }
    throw new KrvConflictError(key);
  }) as unknown as <const Key extends KrvAnyKey<Tables>>(
    key: Key,
    patch:
      | KrvPatch<KrvInputAt<Tables, E, Key>>
      | ((
        row: KrvValueAt<Tables, E, Key>,
      ) => KrvPatch<KrvInputAt<Tables, E, Key>>),
    options?: KrvUpdateOptions,
  ) => Promise<KrvValueAt<Tables, E, Key>>;

  /**
   * Creates a new row. Key fields and `"id"` fields left out of `value` get a
   * new ULID (time-ordered, so rows list in insertion order).
   *
   * @param literals The table's literal key parts: `["posts"]` for
   *   `["posts", "{postId}"]`, `["orgs", "members"]` for
   *   `["orgs", "{orgId}", "members", "{memberId}"]`.
   * @param value The row. Validated against the table's schema.
   * @param options `expireIn`: milliseconds until the row expires.
   * @returns The commit result, plus the row's `key` and `value` (including
   *   generated fields and timestamps).
   * @throws KrvValidationError if `value` doesn't match the schema.
   * @throws KrvConflictError if the key or a unique index value is taken.
   * @throws KrvReferenceError if a reference points at a missing row.
   *
   * @example
   * ```ts
   * const user = await db.insert(["users"], { name: "Pablo" });
   * user.key;      // ["users", "01J…"]
   * user.value.id; // "01J…"
   * ```
   */
  const insert = (async (
    literals: KrvKey,
    value: Row,
    options: KrvInsertOptions = {},
  ) => {
    const table = registry.resolveLiterals(literals);
    const now = Date.now();
    const row = fill(table, value, null, null, now);
    validate(table, row, new Set());

    const key = registry.rowKey(table, row);
    const written = await write(key, row, { ...options, check: null });
    return {
      ...written.result,
      key,
      value: output(table, written.row, written.stored),
    };
  }) as unknown as <const Literals extends KrvAnyLiterals<Tables>>(
    literals: Literals,
    value: KrvInputAtLiterals<Tables, E, Literals>,
    options?: KrvInsertOptions,
  ) => Promise<
    KrvCommitResult & {
      key: KrvRowKeyAtLiterals<Tables, Literals>;
      value: KrvValueAtLiterals<Tables, E, Literals>;
    }
  >;

  /**
   * Deletes a row, in one atomic commit together with its indexes. Deleting a
   * row that doesn't exist does nothing.
   *
   * @param key Full row key.
   * @param options
   *   - `cascade`: also delete every row referencing this one, recursively.
   *     Without it, deleting a referenced row throws.
   *   - `check`: only delete if the row's current versionstamp matches.
   * @throws KrvReferenceError if the row is referenced and `cascade` is not set.
   * @throws KrvConflictError if `check` fails.
   *
   * @example
   * ```ts
   * await db.delete(["posts", postId]);
   * await db.delete(["users", userId], { cascade: true }); // and their posts
   * ```
   */
  const remove = async <const Key extends KrvAnyKey<Tables>>(
    key: Key,
    options: KrvDeleteOptions = {},
  ): Promise<void> => {
    const table = registry.resolveKey(key);
    const { check, cascade = false } = options;

    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await backoff(attempt);

      const current = await state.kv.get<Row>(key);
      if (check !== undefined && current.versionstamp !== check) {
        throw new KrvConflictError(key);
      }
      if (current.versionstamp === null) return;

      const batch = new WriteBatch().check(key, current.versionstamp);
      await planDelete(batch, table, key, current.value, cascade, new Set());

      const result = await commitWithLockRetry(() => batch.build(state.kv));
      if (result.ok) return;
    }

    throw new KrvConflictError(key);
  };

  /**
   * Checks a plain value against a transformed field's stored value, e.g. a
   * password against its bcrypt hash. Uses the transform's `compare`; without
   * one, a deterministic transform compares saved values, and one with `load`
   * compares loaded values.
   *
   * @returns `false` if the row or the field doesn't exist.
   * @throws Error if the field isn't transformed, or can't be compared.
   *
   * @example
   * ```ts
   * const ok = await db.compare(["users", id], "password", input.password);
   * ```
   */
  const compare = async <const Key extends KrvAnyKey<Tables>>(
    key: Key,
    fieldName: KrvFieldAt<Tables, E, Key>,
    plain: unknown,
  ): Promise<boolean> => {
    const field = fieldName as unknown as string;
    const table = registry.resolveKey(key);
    const transformed = table.transformed.find((t) => t.field === field);
    if (!transformed) {
      throw new Error(`${table.name}.${field} has no transform to compare`);
    }
    if (transformed.modifiers.length) {
      throw new Error(
        `${table.name}.${field}: arrays and maps can't be compared`,
      );
    }

    const entry = await state.kv.get<Row>(key);
    const stored = entry.value?.[field];
    if (stored === undefined || stored === null) return false;

    const { transform } = transformed;
    if (transform.compare) return await transform.compare(plain, stored);
    if (transform.deterministic) {
      return deepEqual(await transform.save(plain), stored);
    }
    if (transform.load) return deepEqual(await transform.load(stored), plain);
    throw new Error(
      `${table.name}.${field}: transform "${transformed.char}" has no compare`,
    );
  };

  async function* fetchRows(
    keys: KrvKey[],
    consistency?: Deno.KvConsistencyLevel,
  ) {
    for (let i = 0; i < keys.length; i += GET_MANY_LIMIT) {
      const entries = await state.kv.getMany<Row[]>(
        keys.slice(i, i + GET_MANY_LIMIT),
        { consistency },
      );
      for (const entry of entries) {
        if (entry.versionstamp !== null) yield entry as KrvEntry<Row>;
      }
    }
  }

  /** Rows whose keys are listed under an index prefix (rest of the key). */
  async function* scanKeys(prefix: KrvKey, options: KrvListOptions<Row>) {
    const { reverse, consistency } = options;
    let keys: KrvKey[] = [];
    const entries = state.kv.list({ prefix }, { reverse, consistency });
    for await (const entry of entries) {
      keys.push(entry.key.slice(prefix.length));
      if (keys.length === GET_MANY_LIMIT) {
        yield* fetchRows(keys, consistency);
        keys = [];
      }
    }
    if (keys.length) yield* fetchRows(keys, consistency);
  }

  /** The key prefix `where` pins down, from the start of the key pattern. */
  const keyPrefix = (table: ParsedTable, where: Row) => {
    const prefix: KrvKeyPart[] = [];
    for (const part of table.pattern) {
      if ("literal" in part) {
        prefix.push(part.literal);
        continue;
      }
      const value = where[table.bindings[part.placeholder]];
      if (!isKeyPart(value)) break;
      prefix.push(value);
    }
    return prefix;
  };

  /** Rows of `table`, scanning the longest key prefix `where` pins down. */
  async function* scanTable(
    table: ParsedTable,
    prefix: KrvKey,
    options: KrvListOptions<Row>,
  ) {
    const entries = state.kv.list<Row>({ prefix }, {
      reverse: options.reverse,
      consistency: options.consistency,
    });
    for await (const entry of entries) {
      if (entry.key[0] === INTERNAL || !registry.matches(table, entry.key)) {
        continue;
      }
      yield entry as KrvEntry<Row>;
    }
  }

  /** Picks the narrowest way to read the rows `where` can match. */
  async function* plan(
    table: ParsedTable,
    where: Row,
    plainWhere: Row,
    options: KrvListOptions<Row>,
  ): AsyncGenerator<KrvEntry<Row>> {
    const prefix = keyPrefix(table, where);
    // Every key part is known: that's a single row.
    if (prefix.length === table.pattern.length) {
      return yield* fetchRows([prefix], options.consistency);
    }

    const covered = (await Promise.all(
      table.indexes.map(async (index) => ({
        index,
        values: await registry.whereIndexValues(index, where, plainWhere),
      })),
    ))
      .filter((c): c is { index: ParsedIndex; values: KrvKeyPart[] } =>
        c.values !== null
      )
      .sort((a, b) =>
        Number(b.index.unique) - Number(a.index.unique) ||
        b.index.fields.length - a.index.fields.length
      );
    const best = covered[0];
    if (best?.index.unique) {
      const owner = await state.kv.get<KrvKey>(
        uniqueKey(table.name, best.index.name, best.values),
        { consistency: options.consistency },
      );
      if (owner.value) yield* fetchRows([owner.value], options.consistency);
      return;
    }
    if (best) {
      return yield* scanKeys(
        secondaryPrefix(table.name, best.index.name, best.values),
        options,
      );
    }

    for (const reference of table.references) {
      const target = registry.targetKey(reference, where);
      if (target) {
        return yield* scanKeys(
          indexPrefix(table.name, reference.field, target),
          options,
        );
      }
    }

    yield* scanTable(table, prefix, options);
  }

  /**
   * Lists a table's rows, in key order.
   *
   * The result can be awaited for an array of rows, or iterated with
   * `for await` to stream them. Each use reads again.
   *
   * @param literals The table's literal key parts, as for `insert`.
   * @param options
   *   - `where`: equality on top-level fields; nested objects match
   *     partially. Transformed fields are compared by their saved value (only
   *     deterministic transforms). Key fields, unique and secondary indexes
   *     and references narrow what's read; other fields are compared while
   *     scanning.
   *   - `filter`: any condition on the (loaded) row, after `where`.
   *   - `limit`: maximum number of rows, counted after `where` and `filter`.
   *   - `reverse`: reverse key order (newest first for ULID keys).
   *   - `consistency`: `"strong"` (default) or `"eventual"`.
   *   - `values`: `false` to get `{ key, value, versionstamp }` entries
   *     instead of just the rows (default `true`).
   * @throws Error right away (not while iterating) for an unknown table, or a
   *   `where` on a field whose transform isn't deterministic.
   *
   * @example
   * ```ts
   * const posts = await db.list(["posts"], { where: { authorId }, limit: 10 });
   * posts[0].title;
   *
   * for await (const post of db.list(["posts"])) console.log(post.title);
   *
   * const [entry] = await db.list(["posts"], { values: false });
   * entry.key; // ["posts", "01J…"]
   * ```
   */
  const list = ((
    literals: KrvKey,
    options: KrvListOptions<Row> & {
      expand?: Record<string, KrvExpandSpec>;
    } = {},
  ) => {
    const table = registry.resolveLiterals(literals);
    const opts = options;
    const expansions = resolveExpand(table, opts.expand);
    const plainWhere: Row = opts.where ?? {};
    const limit = opts.limit ?? Infinity;

    for (const field of Object.keys(plainWhere)) {
      const t = table.transformed.find((t) => t.field === field);
      if (
        t && !t.transform.deterministic &&
        !registry.searchableByIndex(table, field)
      ) {
        throw new Error(
          `${table.name}.${field}: can't search a "${t.char}" field, its ` +
            `transform isn't deterministic. Add an index using a ` +
            `deterministic transform: { fields: ["${field}"], using: "#" }`,
        );
      }
    }

    async function* read() {
      // Fields compared as stored (transformed like a write), and fields
      // compared once loaded (encrypted ones, found through a `using` index).
      const stored: Row = {};
      const loaded: Row = {};
      for (const [field, value] of Object.entries(plainWhere)) {
        if (value === undefined) continue;
        const t = table.transformed.find((t) => t.field === field);
        if (t && !t.transform.deterministic) loaded[field] = value;
        else stored[field] = await saveWhereValue(table, field, value);
      }

      // Rows are expanded in batches, so forward expands share reads.
      let batch: { entry: KrvEntry<Row>; value: Row }[] = [];
      const flush = async function* () {
        await expandRows(
          table,
          batch.map((b) => b.value),
          expansions,
          opts.consistency,
        );
        for (const { entry, value } of batch) {
          yield opts.values === false ? { ...entry, value } : value;
        }
        batch = [];
      };

      let count = 0;
      for await (const entry of plan(table, stored, plainWhere, opts)) {
        if (count >= limit) break;
        // Re-check every condition: also guards against a stale index read.
        if (
          !Object.entries(stored).every(([f, v]) =>
            matchesWhere(entry.value[f], v)
          )
        ) continue;

        const value = await loadRow(table, entry.value);
        if (
          !Object.entries(loaded).every(([f, v]) => matchesWhere(value[f], v))
        ) continue;
        if (opts.filter && !opts.filter(value)) continue;
        count++;
        batch.push({ entry, value });
        if (batch.length === GET_MANY_LIMIT) yield* flush();
      }
      if (batch.length) yield* flush();
    }

    return {
      [Symbol.asyncIterator]: () => read(),
      then: <R1, R2>(
        onFulfilled?: (rows: unknown[]) => R1 | PromiseLike<R1>,
        onRejected?: (error: unknown) => R2 | PromiseLike<R2>,
      ) => Array.fromAsync(read()).then(onFulfilled, onRejected),
    };
  }) as unknown as <
    const Literals extends KrvAnyLiterals<Tables>,
    const Values extends boolean = true,
    const X extends Record<string, unknown> = Record<never, never>,
  >(
    literals: Literals,
    options?:
      & KrvListOptions<
        KrvValueAtLiterals<Tables, E, Literals>,
        KrvWhereAtLiterals<Tables, E, Literals>
      >
      & {
        values?: Values;
        expand?:
          & X
          & KrvExpand<Tables, E, KrvTableAtLiterals<Tables, Literals>>
          & NoInfer<
            KrvExpandNoClash<X, KrvTableAtLiterals<Tables, Literals>, E>
          >;
      },
  ) => Values extends false ? KrvListResult<
      KrvExpanded<
        Tables,
        E,
        KrvTableAtLiterals<Tables, Literals>,
        KrvValueAtLiterals<Tables, E, Literals>,
        X
      >,
      KrvRowKeyAtLiterals<Tables, Literals>
    >
    : KrvValuesResult<
      KrvExpanded<
        Tables,
        E,
        KrvTableAtLiterals<Tables, Literals>,
        KrvValueAtLiterals<Tables, E, Literals>,
        X
      >
    >;

  /** `list` as an array of rows, untyped (used by reverse expands). */
  const listRows = (
    literals: KrvKey,
    options: KrvListOptions<Row> & { expand?: Record<string, KrvExpandSpec> },
  ) =>
    Array.fromAsync(
      (list as unknown as (
        literals: KrvKey,
        options: KrvListOptions<Row>,
      ) => AsyncIterable<Row>)(literals, options),
    );

  /**
   * Finds the first row matching `where` and `filter`, in key order, or
   * `null`. Same options as `list` (without `limit`), and uses the same
   * indexes.
   *
   * @param literals The table's literal key parts, as for `insert`.
   * @param options `where`, `filter`, `reverse`, `consistency`, and
   *   `values: false` to get `{ key, value, versionstamp }` instead of the row.
   * @throws Error (rejects) for an unknown table, or a `where` on a field that
   *   can't be searched.
   *
   * @example
   * ```ts
   * const user = await db.find(["users"], { where: { email } });
   * if (user) console.log(user.name);
   * ```
   */
  const find = (async (
    literals: KrvKey,
    options: Omit<KrvListOptions<Row>, "limit"> = {},
  ) => {
    // Plain list call: validates the table and `where` right away.
    const rows = (list as unknown as (
      literals: KrvKey,
      options: KrvListOptions<Row>,
    ) => AsyncIterable<unknown>)(literals, { ...options, limit: 1 });
    for await (const row of rows) return row;
    return null;
  }) as unknown as <
    const Literals extends KrvAnyLiterals<Tables>,
    const Values extends boolean = true,
    const X extends Record<string, unknown> = Record<never, never>,
  >(
    literals: Literals,
    options?:
      & Omit<
        KrvListOptions<
          KrvValueAtLiterals<Tables, E, Literals>,
          KrvWhereAtLiterals<Tables, E, Literals>
        >,
        "limit"
      >
      & {
        values?: Values;
        expand?:
          & X
          & KrvExpand<Tables, E, KrvTableAtLiterals<Tables, Literals>>
          & NoInfer<
            KrvExpandNoClash<X, KrvTableAtLiterals<Tables, Literals>, E>
          >;
      },
  ) => Promise<
    | (Values extends false ? KrvEntry<
        KrvExpanded<
          Tables,
          E,
          KrvTableAtLiterals<Tables, Literals>,
          KrvValueAtLiterals<Tables, E, Literals>,
          X
        >,
        KrvRowKeyAtLiterals<Tables, Literals>
      >
      : KrvExpanded<
        Tables,
        E,
        KrvTableAtLiterals<Tables, Literals>,
        KrvValueAtLiterals<Tables, E, Literals>,
        X
      >)
    | null
  >;

  /** Closes the database. */
  const close = () => state.kv.close();

  return {
    get,
    set,
    update,
    insert,
    delete: remove,
    list,
    find,
    compare,
    close,
  };
};

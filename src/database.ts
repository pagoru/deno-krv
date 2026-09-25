import { monotonicUlid } from "@std/ulid";
import type {
  KrvCommitResult,
  KrvDatabase,
  KrvEntry,
  KrvExpandSpec,
  KrvDeleteOptions,
  KrvGetOptions,
  KrvInsertOptions,
  KrvKey,
  KrvKeyPart,
  KrvListOptions,
  KrvSetOptions,
  KrvTables,
  KrvTransform,
  KrvUpdateOptions,
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
  DELETED_AT,
  EXPIRE_AT,
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
  softKey,
  softOfKey,
  softOfPrefix,
  softPrefix,
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

/** A soft delete's group, stored at `softKey` until it's restored or purged. */
type SoftGroup = {
  root: KrvKey;
  members: { key: KrvKey; table: string; expireAt?: number }[];
};
/** Stored at `softOfKey` for each member of a group. */
type SoftOf = { purgeAt: number; root: KrvKey };

/** Milliseconds until `row` expires (at least 1), or undefined if it doesn't. */
const expireInOf = (row: Row, now: number) => {
  const at = row[EXPIRE_AT];
  return typeof at === "number" ? Math.max(1, at - now) : undefined;
};

/** Past its `expireAt` (Deno KV removes expired keys some time later). */
const isExpired = (row: Row, now = Date.now()) => {
  const at = row[EXPIRE_AT];
  return typeof at === "number" && at <= now;
};

/** Left out of reads: expired, or soft-deleted unless `deleted` is set. */
const isHidden = (row: Row, deleted?: boolean) =>
  isExpired(row) || (!deleted && row[DELETED_AT] !== undefined);

/** The open `Deno.Kv`. Replaced while migrations take and restore backups. */
export type DatabaseState = { kv: Deno.Kv };

/**
 * The typed read/write API over a registry. `Tables` and `E` (validators and
 * transforms) only drive the types.
 */
export const createDatabase = <Tables extends KrvTables, E>(
  state: DatabaseState,
  registry: Registry,
): Omit<KrvDatabase<Tables, E>, "backup" | "restoreBackup"> => {
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

  /**
   * The `raw` fields present in `value`. Throws for a field without a
   * transform, since it has no stored form to pass.
   */
  const rawFields = (
    table: ParsedTable,
    raw: readonly string[] | undefined,
    value: Row,
  ): Set<string> => {
    for (const field of raw ?? []) {
      if (!table.transformed.some((t) => t.field === field)) {
        throw new Error(
          `${table.name}.${field}: raw needs a transformed field`,
        );
      }
    }
    return new Set(
      (raw ?? []).filter((f) => value[f] !== undefined && value[f] !== null),
    );
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
    const entry = pending === "delete" ? null : await state.kv.get<Row>(target);
    if (!entry || entry.versionstamp === null || isHidden(entry.value)) {
      throw new KrvReferenceError(
        `${table.name}.${reference.field}: ${keyToString(
          target,
        )} does not exist`,
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
    refresh: boolean,
  ) => {
    const moved = oldKey !== null && !keysEqual(oldKey, key);
    for (const index of table.indexes) {
      const before = oldRow
        ? await registry.indexValues(table, index, oldRow)
        : null;
      const after = await registry.indexValues(table, index, row);
      const same = before && after && keysEqual(before, after);
      if (same && !moved && !refresh) continue;

      if (before) removeIndex(batch, table, index, before, oldKey!);
      if (!after) continue;

      if (index.unique) {
        const unique = uniqueKey(table.name, index.name, after);
        const taken = await state.kv.get<KrvKey>(unique);
        const owner = taken.value;
        if (
          owner &&
          !keysEqual(owner, key) &&
          !(oldKey && keysEqual(owner, oldKey)) &&
          batch.pending(owner) !== "delete"
        ) {
          throw new KrvConflictError(
            key,
            `${table.name}.${index.name}: ${index.fields.join(
              ", ",
            )} already taken by ${keyToString(owner)} (unique)`,
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
   * move in turn). They expire at the row's `expireAt`, if it has one.
   * `refresh` re-writes unchanged index entries too, for a new expiry.
   */
  const planWrite = async (
    batch: WriteBatch,
    table: ParsedTable,
    oldKey: KrvKey | null,
    oldRow: Row | null,
    row: Row,
    visited: Set<string>,
    now: number,
    refresh = false,
  ) => {
    const expireIn = expireInOf(row, now);
    const key = registry.rowKey(table, row);
    visited.add(keyId(key));
    const moved = oldKey !== null && !keysEqual(oldKey, key);

    if (moved) {
      if (batch.pending(key) !== "delete") {
        const existing = await state.kv.get(key);
        if (existing.versionstamp !== null) {
          throw new KrvConflictError(
            key,
            `Can't move ${keyToString(oldKey)} to ${keyToString(
              key,
            )}: it already exists`,
          );
        }
        batch.check(key, null);
      }
      batch.delete(oldKey);
    }
    batch.set(key, row, expireIn, true);

    await planIndexes(
      batch,
      table,
      oldKey,
      oldRow,
      key,
      row,
      expireIn,
      refresh,
    );

    // Outgoing references.
    for (const reference of table.references) {
      const before = oldRow ? registry.targetKey(reference, oldRow) : null;
      const after = registry.targetKey(reference, row);
      const sameTarget = before && after && keysEqual(before, after);
      if (sameTarget && !moved) {
        if (refresh) {
          batch.set(
            indexKey(table.name, reference.field, after, key),
            null,
            expireIn,
          );
        }
        continue;
      }

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
          visited,
          now,
        );
      }
    }
  };

  /** A row whose references to deleted rows are cleared (`cascade: "unset"`). */
  type Unset = {
    table: ParsedTable;
    key: KrvKey;
    before: Row;
    after: Row;
  };

  /**
   * Adds deleting `key` to `batch`. Rows referencing it are deleted too when
   * `cascade` is set; otherwise their existence throws. With `"unset"`, rows
   * whose reference can be empty are collected in `unsets` instead, to be
   * written once every delete is planned (a delete of the same row wins).
   * `row` is null when it's already gone (expired along with its entries),
   * leaving only the rows that reference it.
   */
  const planDelete = async (
    batch: WriteBatch,
    table: ParsedTable,
    key: KrvKey,
    row: Row | null,
    cascade: KrvDeleteOptions["cascade"],
    visited: Set<string>,
    unsets: Map<string, Unset>,
  ) => {
    if (visited.has(keyId(key))) return;
    visited.add(keyId(key));
    batch.delete(key);

    if (row) {
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
            `Can't delete ${keyToString(key)}: referenced by ${keyToString(
              childKey,
            )} (${source.name}.${reference.field}). ` +
              `Pass { cascade: true } to delete it too.`,
          );
        }

        const child = await state.kv.get<Row>(childKey);
        if (child.versionstamp === null) {
          batch.delete(entry.key); // stale index entry
          continue;
        }
        batch.check(childKey, child.versionstamp);

        if (cascade === "unset" && reference.unset) {
          const id = keyId(childKey);
          const unset = unsets.get(id) ?? {
            table: source,
            key: childKey,
            before: child.value,
            after: { ...child.value },
          };
          unset.after[reference.field] =
            reference.unset === "null" ? null : undefined;
          unsets.set(id, unset);
          continue;
        }

        await planDelete(
          batch,
          source,
          childKey,
          child.value,
          cascade,
          visited,
          unsets,
        );
      }
    }
  };

  /** Writes the rows `planDelete` collected, unless they're deleted too. */
  const planUnsets = async (
    batch: WriteBatch,
    unsets: Map<string, Unset>,
    now: number,
  ) => {
    for (const { table, key, before, after } of unsets.values()) {
      if (batch.pending(key) === "delete") continue;
      if (table.timestamps) after.updatedAt = now;
      await planWrite(batch, table, key, before, after, new Set(), now);
    }
  };

  /**
   * Adds soft-deleting `key` to `batch`: the row gets `deletedAt` and expires
   * at `purgeAt` (or earlier, if it already did), and so do its index
   * entries. Rows with a required reference to it join the group; those with
   * an optional one are left as they are (reads show it unset until purged).
   */
  const planSoftDelete = async (
    batch: WriteBatch,
    table: ParsedTable,
    key: KrvKey,
    row: Row,
    group: SoftGroup,
    now: number,
    purgeAt: number,
    visited: Set<string>,
  ) => {
    if (visited.has(keyId(key))) return;
    visited.add(keyId(key));

    const expireAt = row[EXPIRE_AT] as number | undefined;
    group.members.push({
      key,
      table: table.name,
      ...(expireAt !== undefined && { expireAt }),
    });
    const next = {
      ...row,
      [DELETED_AT]: now,
      [EXPIRE_AT]: Math.min(expireAt ?? Infinity, purgeAt),
    };
    await planWrite(batch, table, key, row, next, new Set(), now, true);
    batch.set(softOfKey(table.name, key), {
      purgeAt,
      root: group.root,
    } satisfies SoftOf);

    if (table.incoming.length === 0) return;

    // A reference added meanwhile touches the guard: the commit retries.
    const guard = guardKey(key);
    const guardEntry = await state.kv.get(guard);
    batch.check(guard, guardEntry.versionstamp);

    for (const { source, reference } of table.incoming) {
      if (reference.unset) continue;
      const prefix = indexPrefix(source.name, reference.field, key);
      for await (const entry of state.kv.list({ prefix })) {
        const childKey = entry.key.slice(prefix.length);
        const child = await state.kv.get<Row>(childKey);
        if (child.versionstamp === null) {
          batch.delete(entry.key); // stale index entry
          continue;
        }
        // Already soft-deleted by another group: it goes with that one.
        if (child.value[DELETED_AT] !== undefined) continue;
        batch.check(childKey, child.versionstamp);
        await planSoftDelete(
          batch,
          source,
          childKey,
          child.value,
          group,
          now,
          purgeAt,
          visited,
        );
      }
    }
  };

  /**
   * Deletes a soft delete's group for good, like `cascade: "unset"`: rows
   * with an optional reference to a member get it cleared.
   * @returns Whether the group was still there.
   */
  const purgeGroup = async (purgeAt: number, root: KrvKey) => {
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await backoff(attempt);

      const group = await state.kv.get<SoftGroup>(softKey(purgeAt, root));
      if (group.value === null) return false;
      const batch = new WriteBatch().check(group.key, group.versionstamp);
      batch.delete(group.key);

      const visited = new Set<string>();
      const unsets = new Map<string, Unset>();
      for (const member of group.value.members) {
        batch.delete(softOfKey(member.table, member.key));
        const table = registry.byName(member.table);
        if (!table) continue;
        const entry = await state.kv.get<Row>(member.key);
        batch.check(member.key, entry.versionstamp);
        // Not soft-deleted anymore: rewritten after a hard delete. Leave it.
        if (entry.value && entry.value[DELETED_AT] === undefined) continue;
        await planDelete(
          batch,
          table,
          member.key,
          entry.value,
          "unset",
          visited,
          unsets,
        );
      }
      await planUnsets(batch, unsets, Date.now());

      const result = await commitWithLockRetry(() => batch.build(state.kv));
      if (result.ok) return true;
    }
    throw new KrvConflictError(root);
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
    const raw = rawFields(table, options.raw, value);

    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await backoff(attempt);

      const current = await state.kv.get<Row>(key);
      if (check !== undefined && current.versionstamp !== check) {
        throw new KrvConflictError(key);
      }
      if (current.value && current.value[DELETED_AT] !== undefined) {
        throw new KrvConflictError(
          key,
          `${keyToString(key)} is soft-deleted: restore it first`,
        );
      }

      // Opaque fields (e.g. hashes) passed back unchanged are kept as stored.
      const keep = new Set(
        [...table.opaque].filter(
          (field) =>
            current.value &&
            value[field] !== undefined &&
            deepEqual(value[field], current.value[field]),
        ),
      );

      const now = Date.now();
      const filled = fill(table, value, key, current.value, now);
      delete filled[DELETED_AT]; // only soft deletes set it
      if (expireIn !== undefined) filled[EXPIRE_AT] = now + expireIn;
      else if (isExpired(filled, now)) {
        throw new KrvValidationError([
          `${table.name}.${EXPIRE_AT}: ${filled[EXPIRE_AT]} is already past`,
        ]);
      }
      // Raw fields: stored as given, but loaded (when they can be) to check
      // they're readable and valid, and to return their plain values.
      const rawStored = Object.fromEntries([...raw].map((f) => [f, filled[f]]));
      const row = { ...filled, ...(await loadRow(table, rawStored)) };
      validate(
        table,
        row,
        new Set([...keep, ...[...raw].filter((f) => table.opaque.has(f))]),
      );

      const exists = current.versionstamp !== null;
      if (!exists && !keysEqual(registry.rowKey(table, row), key)) {
        throw new Error(
          `Key ${keyToString(key)} doesn't match the key fields of the value ` +
            `(${keyToString(registry.rowKey(table, row))})`,
        );
      }

      const stored = {
        ...(await saveRow(table, row, new Set([...keep, ...raw]))),
        ...rawStored,
      };
      const batch = new WriteBatch().check(key, current.versionstamp);
      await planWrite(
        batch,
        table,
        exists ? key : null,
        current.value,
        stored,
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

  /**
   * Shows references to soft-deleted rows as `cascade: "unset"` will leave
   * them once purged (`undefined` or `null`). One per read: it remembers
   * which tables have soft-deleted rows, and which targets are.
   */
  const createUnsetView = (consistency?: Deno.KvConsistencyLevel) => {
    const tables = new Map<string, Promise<boolean>>();
    const targets = new Map<string, Promise<boolean>>();
    const hasSoft = (table: string) => {
      let found = tables.get(table);
      if (!found) {
        found = (async () => {
          const entries = state.kv.list(
            { prefix: softOfPrefix(table) },
            { limit: 1, consistency },
          );
          for await (const _ of entries) return true;
          return false;
        })();
        tables.set(table, found);
      }
      return found;
    };
    const isSoft = (table: string, target: KrvKey) => {
      const id = keyId(target);
      let found = targets.get(id);
      if (!found) {
        found = state.kv
          .get(softOfKey(table, target), { consistency })
          .then((entry) => entry.versionstamp !== null);
        targets.set(id, found);
      }
      return found;
    };

    /** Clears `row`'s references to soft-deleted rows, in place. */
    return async (table: ParsedTable, row: Row) => {
      for (const reference of table.references) {
        if (!reference.unset || !(await hasSoft(reference.target))) continue;
        const target = registry.targetKey(reference, row);
        if (target && (await isSoft(reference.target, target))) {
          row[reference.field] = reference.unset === "null" ? null : undefined;
        }
      }
    };
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
        const reference = table.references.find(
          (r) => r.field === options.from,
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
      const reference = source?.references.find(
        (r) => r.field === field && r.target === table.name,
      );
      if (!source || !reference) {
        throw new Error(
          `${where}: "${options.from}" isn't a field of another table referencing ${table.name}`,
        );
      }
      resolveExpand(source, options.expand); // validate nested now
      const single =
        table.pattern.length > 0 &&
        source.pattern.every(
          (part) =>
            !("placeholder" in part) ||
            reference.fields[part.placeholder] ===
              source.bindings[part.placeholder],
        );
      return { name, kind: "reverse", reference, source, single, options };
    });

  /**
   * Adds each expansion to `rows` (loaded values), in place. Without
   * `deleted`, soft-deleted rows are left out and references to them unset.
   */
  const expandRows = async (
    table: ParsedTable,
    rows: Row[],
    expansions: Expansion[],
    consistency: Deno.KvConsistencyLevel | undefined,
    deleted: boolean | undefined,
  ): Promise<void> => {
    const view = deleted ? null : createUnsetView(consistency);
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
          if (isHidden(entry.value, deleted)) continue;
          const value = await loadRow(expansion.target, entry.value);
          await view?.(expansion.target, value);
          found.set(keyId(entry.key), value);
          targets.push(value);
        }
        await expandRows(
          expansion.target,
          targets,
          expansion.nested,
          consistency,
          deleted,
        );
        for (const row of rows) {
          const target = registry.targetKey(expansion.reference, row);
          row[expansion.name] = target
            ? (found.get(keyId(target)) ?? null)
            : null;
        }
        continue;
      }

      // Reverse: the referencing rows, through the reference's index.
      const { source, reference, single, options } = expansion;
      await Promise.all(
        rows.map(async (row) => {
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
            deleted,
            expand: options.expand,
          });
          row[expansion.name] = single ? (found[0] ?? null) : found;
        }),
      );
    }
  };

  const get = (async (
    key: KrvKey,
    options: KrvGetOptions & { expand?: Record<string, KrvExpandSpec> } = {},
  ) => {
    const table = registry.resolveKey(key);
    const expansions = resolveExpand(table, options.expand);
    const { consistency, deleted } = options;
    const entry = await state.kv.get<Row>(key, { consistency });
    const missing = { key: entry.key, value: null, versionstamp: null };
    if (entry.value === null || isHidden(entry.value, deleted)) {
      return options.values === false ? missing : null;
    }
    const value = await loadRow(table, entry.value);
    if (!deleted) await createUnsetView(consistency)(table, value);
    await expandRows(table, [value], expansions, consistency, deleted);
    return options.values === false ? { ...entry, value } : value;
  }) as unknown as KrvDatabase<Tables, E>["get"];

  /** A write's result: the row, or its `{ key, value, versionstamp }` entry. */
  const written = (
    table: ParsedTable,
    { result, row, stored }: { result: KrvCommitResult; row: Row; stored: Row },
    values: boolean | undefined,
  ) => {
    const value = output(table, row, stored);
    if (values !== false) return value;
    // The row's own key: a write that changes a key field moves it.
    const key = registry.rowKey(table, row);
    return { key, value, versionstamp: result.versionstamp };
  };

  const set = (async (key: KrvKey, value: Row, options: KrvSetOptions = {}) =>
    written(
      registry.resolveKey(key),
      await write(key, value, options),
      options.values,
    )) as unknown as KrvDatabase<Tables, E>["set"];

  const update = (async (
    key: KrvKey,
    patch: Row | ((row: Row) => Row),
    options: KrvUpdateOptions = {},
  ) => {
    const table = registry.resolveKey(key);
    rawFields(table, options.raw, {}); // checks the names before filtering them
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await backoff(attempt);

      const current = await state.kv.get<Row>(key);
      if (current.versionstamp === null) throw new KrvNotFoundError(key);
      if (
        options.check !== undefined &&
        current.versionstamp !== options.check
      ) {
        throw new KrvConflictError(key);
      }

      const loaded = await loadRow(table, current.value);
      const changes = typeof patch === "function" ? patch(loaded) : patch;
      const merged = mergePatch(table.schema.fields, loaded, changes);
      try {
        const result = await write(key, merged, {
          check: current.versionstamp,
          expireIn: options.expireIn,
          // Only what the patch sets: the rest of `merged` is loaded values.
          raw: options.raw?.filter((field) => field in changes),
        });
        return written(table, result, options.values);
      } catch (error) {
        // Someone wrote the row in between: merge again on top of it.
        const now = await state.kv.get(key);
        if (
          error instanceof KrvConflictError &&
          now.versionstamp !== current.versionstamp &&
          options.check === undefined
        )
          continue;
        throw error;
      }
    }
    throw new KrvConflictError(key);
  }) as unknown as KrvDatabase<Tables, E>["update"];

  const insert = (async (
    literals: KrvKey,
    value: Row,
    options: KrvInsertOptions = {},
  ) => {
    const table = registry.resolveLiterals(literals);
    const now = Date.now();
    const row = fill(table, value, null, null, now);
    validate(table, row, rawFields(table, options.raw, row));

    const key = registry.rowKey(table, row);
    const result = await write(key, row, { ...options, check: null });
    return written(table, result, options.values);
  }) as unknown as KrvDatabase<Tables, E>["insert"];

  const remove: KrvDatabase<Tables, E>["delete"] = async (
    key,
    options = {},
  ) => {
    const table = registry.resolveKey(key);
    const { check, cascade = false, soft } = options;
    if (soft !== undefined && !(soft > 0)) {
      throw new Error(`soft must be a positive number of milliseconds`);
    }

    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await backoff(attempt);

      const current = await state.kv.get<Row>(key);
      if (check !== undefined && current.versionstamp !== check) {
        throw new KrvConflictError(key);
      }
      if (current.versionstamp === null) return;

      const batch = new WriteBatch().check(key, current.versionstamp);
      const now = Date.now();

      if (current.value[DELETED_AT] !== undefined) {
        if (soft !== undefined) {
          throw new KrvConflictError(
            key,
            `${keyToString(key)} is already soft-deleted`,
          );
        }
        // Deleting it for good: its whole group goes now.
        const of = await state.kv.get<SoftOf>(softOfKey(table.name, key));
        if (of.value) {
          await purgeGroup(of.value.purgeAt, of.value.root);
          return;
        }
      }

      if (soft !== undefined) {
        const group: SoftGroup = { root: key, members: [] };
        const purgeAt = now + soft;
        await planSoftDelete(
          batch,
          table,
          key,
          current.value,
          group,
          now,
          purgeAt,
          new Set(),
        );
        batch.set(softKey(purgeAt, key), group);
      } else {
        const unsets = new Map<string, Unset>();
        await planDelete(
          batch,
          table,
          key,
          current.value,
          cascade,
          new Set(),
          unsets,
        );
        await planUnsets(batch, unsets, now);
      }

      const result = await commitWithLockRetry(() => batch.build(state.kv));
      if (result.ok) return;
    }

    throw new KrvConflictError(key);
  };

  const restore: KrvDatabase<Tables, E>["restore"] = async (key) => {
    const table = registry.resolveKey(key);
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      if (attempt > 0) await backoff(attempt);

      const now = Date.now();
      const of = await state.kv.get<SoftOf>(softOfKey(table.name, key));
      if (of.value === null || of.value.purgeAt <= now) {
        throw new KrvNotFoundError(key);
      }
      const group = await state.kv.get<SoftGroup>(
        softKey(of.value.purgeAt, of.value.root),
      );
      if (group.value === null) throw new KrvNotFoundError(key);

      const batch = new WriteBatch().check(group.key, group.versionstamp);
      batch.delete(group.key);
      for (const member of group.value.members) {
        batch.delete(softOfKey(member.table, member.key));
        const source = registry.byName(member.table);
        const entry = await state.kv.get<Row>(member.key);
        if (!source || entry.value === null) continue;
        batch.check(member.key, entry.versionstamp);

        const next = { ...entry.value };
        delete next[DELETED_AT];
        if (member.expireAt === undefined) delete next[EXPIRE_AT];
        else next[EXPIRE_AT] = member.expireAt;
        await planWrite(
          batch,
          source,
          member.key,
          entry.value,
          next,
          new Set(),
          now,
          true,
        );
      }

      const result = await commitWithLockRetry(() => batch.build(state.kv));
      if (result.ok) return;
    }
    throw new KrvConflictError(key);
  };

  const purge: KrvDatabase<Tables, E>["purge"] = async () => {
    let purged = 0;
    const due = state.kv.list<SoftGroup>({
      start: softPrefix,
      end: [...softPrefix, Date.now()],
    });
    for await (const { key, value } of due) {
      if (await purgeGroup(key[softPrefix.length] as number, value.root)) {
        purged++;
      }
    }
    return purged;
  };

  const compare: KrvDatabase<Tables, E>["compare"] = async (
    key,
    fieldName,
    plain,
  ) => {
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
    if (entry.value === null || isHidden(entry.value)) return false;
    const stored = entry.value[field];
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
    const entries = state.kv.list<Row>(
      { prefix },
      {
        reverse: options.reverse,
        consistency: options.consistency,
      },
    );
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

    const covered = (
      await Promise.all(
        table.indexes.map(async (index) => ({
          index,
          values: await registry.whereIndexValues(index, where, plainWhere),
        })),
      )
    )
      .filter(
        (c): c is { index: ParsedIndex; values: KrvKeyPart[] } =>
          c.values !== null,
      )
      .sort(
        (a, b) =>
          Number(b.index.unique) - Number(a.index.unique) ||
          b.index.fields.length - a.index.fields.length,
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
        t &&
        !t.transform.deterministic &&
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
      // Fields indexed `using` a transform also match through it (`using:
      // "~"` finds "A@b.c" by "a@B.C"): transform → searched value, saved.
      const usings = new Map<
        string,
        { transform: KrvTransform; value: unknown }[]
      >();
      for (const [field, value] of Object.entries(plainWhere)) {
        if (value === undefined) continue;
        const t = table.transformed.find((t) => t.field === field);
        if (t && !t.transform.deterministic) loaded[field] = value;
        else stored[field] = await saveWhereValue(table, field, value);
        const transforms = new Set(
          table.indexes.flatMap((i) => i.using[field] ?? []),
        );
        usings.set(
          field,
          await Promise.all(
            [...transforms].map(async (transform) => ({
              transform,
              value: await transform.save(value),
            })),
          ),
        );
      }
      /** `value` holds plain values for the fields indexed `using` a transform. */
      const matchesAll = async (value: Row, where: Row) => {
        for (const [field, expected] of Object.entries(where)) {
          if (matchesWhere(value[field], expected)) continue;
          if (value[field] === undefined || value[field] === null) return false;
          let found = false;
          for (const using of usings.get(field) ?? []) {
            const saved = await using.transform.save(value[field]);
            if (matchesWhere(saved, using.value)) {
              found = true;
              break;
            }
          }
          if (!found) return false;
        }
        return true;
      };

      // Rows are expanded in batches, so forward expands share reads.
      let batch: { entry: KrvEntry<Row>; value: Row }[] = [];
      const flush = async function* () {
        await expandRows(
          table,
          batch.map((b) => b.value),
          expansions,
          opts.consistency,
          opts.deleted,
        );
        for (const { entry, value } of batch) {
          yield opts.values === false ? { ...entry, value } : value;
        }
        batch = [];
      };

      const view = opts.deleted ? null : createUnsetView(opts.consistency);
      const references = new Set(table.references.map((r) => r.field));
      let count = 0;
      for await (const entry of plan(table, stored, plainWhere, opts)) {
        if (count >= limit) break;
        if (isHidden(entry.value, opts.deleted)) continue;
        // Re-check every condition: also guards against a stale index read.
        if (!(await matchesAll(entry.value, stored))) continue;

        const value = await loadRow(table, entry.value);
        if (!(await matchesAll(value, loaded))) continue;
        if (view) {
          await view(table, value);
          // A reference to a soft-deleted row no longer matches.
          if (
            !Object.entries(stored).every(
              ([f, v]) => !references.has(f) || matchesWhere(value[f], v),
            )
          )
            continue;
        }
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
  }) as unknown as KrvDatabase<Tables, E>["list"];

  /** `list` as an array of rows, untyped (used by reverse expands). */
  const listRows = (
    literals: KrvKey,
    options: KrvListOptions<Row> & { expand?: Record<string, KrvExpandSpec> },
  ) =>
    Array.fromAsync(
      (
        list as unknown as (
          literals: KrvKey,
          options: KrvListOptions<Row>,
        ) => AsyncIterable<Row>
      )(literals, options),
    );

  const find = (async (
    literals: KrvKey,
    options: Omit<KrvListOptions<Row>, "limit"> = {},
  ) => {
    // Plain list call: validates the table and `where` right away.
    const rows = (
      list as unknown as (
        literals: KrvKey,
        options: KrvListOptions<Row>,
      ) => AsyncIterable<unknown>
    )(literals, { ...options, limit: 1 });
    for await (const row of rows) return row;
    return null;
  }) as unknown as KrvDatabase<Tables, E>["find"];

  const close = () => state.kv.close();

  return {
    get,
    set,
    update,
    insert,
    delete: remove,
    restore,
    purge,
    list,
    find,
    compare,
    close,
  };
};

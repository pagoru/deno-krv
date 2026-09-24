import type { KrvExpand, KrvExpanded, KrvExpandNoClash } from "./expand.ts";
import type { KrvCommitResult } from "./commit.ts";
import type {
  KrvEntry,
  KrvEntryMaybe,
  KrvListResult,
  KrvValuesResult,
} from "./entry.ts";
import type {
  KrvDeleteOptions,
  KrvGetOptions,
  KrvInsertOptions,
  KrvListOptions,
  KrvPatch,
  KrvSetOptions,
  KrvUpdateOptions,
} from "./options.ts";
import type {
  KrvAnyKey,
  KrvAnyLiterals,
  KrvFieldAt,
  KrvInputAt,
  KrvInputAtLiterals,
  KrvRowKeyAtLiterals,
  KrvTableAtKey,
  KrvTableAtLiterals,
  KrvTables,
  KrvValueAt,
  KrvValueAtLiterals,
  KrvWhereAtLiterals,
} from "./table.ts";

/**
 * The typed read/write API returned by `openKRV`. `Tables` and `E`
 * (validators and transforms) drive the row types.
 *
 * `in out` skips variance measurement, which is too deep for these types.
 */
export interface KrvDatabase<in out Tables extends KrvTables, in out E> {
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
  get: <
    const Key extends KrvAnyKey<Tables>,
    const X extends Record<string, unknown> = Record<never, never>,
  >(
    key: Key,
    options?: KrvGetOptions & {
      expand?: X &
        KrvExpand<Tables, E, KrvTableAtKey<Tables, Key>> &
        NoInfer<KrvExpandNoClash<X, KrvTableAtKey<Tables, Key>, E>>;
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
  set: <const Key extends KrvAnyKey<Tables>>(
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
  update: <const Key extends KrvAnyKey<Tables>>(
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
  insert: <const Literals extends KrvAnyLiterals<Tables>>(
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
  delete: <const Key extends KrvAnyKey<Tables>>(
    key: Key,
    options?: KrvDeleteOptions,
  ) => Promise<void>;

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
  list: <
    const Literals extends KrvAnyLiterals<Tables>,
    const Values extends boolean = true,
    const X extends Record<string, unknown> = Record<never, never>,
  >(
    literals: Literals,
    options?: KrvListOptions<
      KrvValueAtLiterals<Tables, E, Literals>,
      KrvWhereAtLiterals<Tables, E, Literals>
    > & {
      values?: Values;
      expand?: X &
        KrvExpand<Tables, E, KrvTableAtLiterals<Tables, Literals>> &
        NoInfer<KrvExpandNoClash<X, KrvTableAtLiterals<Tables, Literals>, E>>;
    },
  ) => Values extends false
    ? KrvListResult<
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
  find: <
    const Literals extends KrvAnyLiterals<Tables>,
    const Values extends boolean = true,
    const X extends Record<string, unknown> = Record<never, never>,
  >(
    literals: Literals,
    options?: Omit<
      KrvListOptions<
        KrvValueAtLiterals<Tables, E, Literals>,
        KrvWhereAtLiterals<Tables, E, Literals>
      >,
      "limit"
    > & {
      values?: Values;
      expand?: X &
        KrvExpand<Tables, E, KrvTableAtLiterals<Tables, Literals>> &
        NoInfer<KrvExpandNoClash<X, KrvTableAtLiterals<Tables, Literals>, E>>;
    },
  ) => Promise<
    | (Values extends false
        ? KrvEntry<
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
  compare: <const Key extends KrvAnyKey<Tables>>(
    key: Key,
    fieldName: KrvFieldAt<Tables, E, Key>,
    plain: unknown,
  ) => Promise<boolean>;

  /** Closes the database. */
  close: () => void;
}

type TablesOf<Db> =
  Db extends KrvDatabase<infer Tables, infer _E> ? Tables : never;

type ReadonlyLiterals<L> = L extends readonly string[] ? Readonly<L> : never;

/**
 * Row type of table, as read back. `Db` is the database's type, so custom
 * validators and transforms resolve; the table is named by its key's literal
 * parts, as in `insert` and `list`.
 *
 * @example
 * ```ts
 * export type Post = KrvRow<typeof db, ["posts"]>;
 * ```
 */
export type KrvRow<Db, Literals extends KrvAnyLiterals<TablesOf<Db>>> =
  Db extends KrvDatabase<infer Tables, infer E>
    ? KrvValueAtLiterals<Tables, E, ReadonlyLiterals<Literals>>
    : never;

/**
 * What `insert` accepts for a table: generated fields and timestamps may be
 * left out.
 *
 * @example
 * ```ts
 * export type NewPost = KrvInput<typeof db, ["posts"]>;
 * ```
 */
export type KrvInput<Db, Literals extends KrvAnyLiterals<TablesOf<Db>>> =
  Db extends KrvDatabase<infer Tables, infer E>
    ? KrvInputAtLiterals<Tables, E, ReadonlyLiterals<Literals>>
    : never;

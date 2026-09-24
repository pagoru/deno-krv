import type {
  KrvNoTransforms,
  KrvNoValidators,
  KrvSchemaDef,
  KrvTableInput,
  KrvTableRow,
  KrvTableWhere,
} from "./schema.ts";

/** A secondary index over top-level fields. */
export type KrvIndex = {
  fields: readonly string[];
  /** Two rows can't share the same values: the second write throws `KrvConflictError`. */
  unique?: boolean;
  /**
   * A deterministic transform applied to the plain value before indexing, so
   * `where` can search a field stored encrypted (a blind index): `"#"` for
   * every field, or `{ phone: "#" }` per field.
   */
  using?: string | Readonly<Record<string, string>>;
};

export type KrvIndexes = Readonly<Record<string, KrvIndex>>;

export type KrvTable<
  Key extends readonly string[] = readonly string[],
  Schema extends KrvSchemaDef = KrvSchemaDef,
  Timestamps extends boolean = boolean,
  Indexes extends KrvIndexes = KrvIndexes,
> = {
  /** Key pattern: literal parts, and `{placeholder}` parts filled from the row. */
  readonly key: Key;
  readonly schema: Schema;
  /** Automatic `createdAt` / `updatedAt` fields. Default `true`. */
  readonly timestamps?: Timestamps;
  readonly indexes?: Indexes;
};

/** A database's tables: a list, each named by its key's literal parts. */
export type KrvTables = readonly KrvTable[];

/** Validators and transforms, as seen by the row types. */
export type KrvEnv<V = KrvNoValidators, T = KrvNoTransforms> = { v: V; t: T };

// deno-lint-ignore no-explicit-any
type AnyTable<Key extends readonly string[] = any, Schema = any, TS = any> = {
  readonly key: Key;
  readonly schema: Schema;
  readonly timestamps?: TS;
};

type TimestampsOf<Table> = Table extends { readonly timestamps?: infer TS }
  ? boolean extends TS
    ? true
    : TS extends false
      ? false
      : true
  : true;

type EnvV<E> = E extends { v: infer V } ? V : KrvNoValidators;
type EnvT<E> = E extends { t: infer T } ? T : KrvNoTransforms;

/** Row type of a table, as read back. */
export type KrvTableValue<Table, E = KrvEnv> =
  Table extends AnyTable<readonly string[], infer Schema>
    ? KrvTableRow<Schema, EnvV<E>, EnvT<E>, TimestampsOf<Table>>
    : never;

/** What `insert`/`set` accept for a table. */
export type KrvTableInputValue<Table, E = KrvEnv> =
  Table extends AnyTable<readonly string[], infer Schema>
    ? KrvTableInput<Schema, EnvV<E>, EnvT<E>, TimestampsOf<Table>>
    : never;

/** Fields covered by an index `using` a transform: searchable even if encrypted. */
type UsingFields<Table> = Table extends { readonly indexes?: infer I }
  ? {
      [N in keyof I]: I[N] extends {
        using: string;
        fields: readonly (infer F)[];
      }
        ? F
        : I[N] extends { using: infer U }
          ? keyof U
          : never;
    }[keyof I]
  : never;

/** `where` of a table. */
export type KrvTableWhereValue<Table, E = KrvEnv> =
  Table extends AnyTable<readonly string[], infer Schema>
    ? KrvTableWhere<
        Schema,
        EnvV<E>,
        EnvT<E>,
        TimestampsOf<Table>,
        UsingFields<Table> & string
      >
    : never;

type KeyPartType<Part> = Part extends `{${string}}` ? string : Part;

/** Row key of a table: `["users", "{userId}"]` → `readonly ["users", string]`. */
export type KrvRowKey<Table> =
  Table extends AnyTable<infer Key>
    ? { readonly [I in keyof Key]: KeyPartType<Key[I]> }
    : never;

type Literals<Key> = Key extends readonly [infer Head, ...infer Rest]
  ? Head extends `{${string}}`
    ? Literals<Rest>
    : [Head, ...Literals<Rest>]
  : [];

/** Literal parts of a table's key, used by `insert` and `list`: `["posts"]`. */
export type KrvTableLiterals<Table> =
  Table extends AnyTable<infer Key> ? Readonly<Literals<Key>> : never;

export type KrvAnyKey<Tables extends KrvTables> = KrvRowKey<Tables[number]>;

export type KrvAnyLiterals<Tables extends KrvTables> = KrvTableLiterals<
  Tables[number]
>;

/** The table (of a union) whose row key `Key` fits. */
type TableAtKeyOf<Table, Key> = Table extends unknown
  ? Key extends KrvRowKey<Table>
    ? Table
    : never
  : never;
export type KrvTableAtKey<Tables extends KrvTables, Key> = TableAtKeyOf<
  Tables[number],
  Key
>;

/** The table (of a union) with exactly these literal key parts. */
type TableAtLiteralsOf<Table, Literals> = Table extends unknown
  ? [Literals] extends [KrvTableLiterals<Table>]
    ? [KrvTableLiterals<Table>] extends [Literals]
      ? Table
      : never
    : never
  : never;
export type KrvTableAtLiterals<
  Tables extends KrvTables,
  Literals,
> = TableAtLiteralsOf<Tables[number], Literals>;

export type KrvValueAt<Tables extends KrvTables, E, Key> = KrvTableValue<
  KrvTableAtKey<Tables, Key>,
  E
>;
export type KrvInputAt<Tables extends KrvTables, E, Key> = KrvTableInputValue<
  KrvTableAtKey<Tables, Key>,
  E
>;

export type KrvValueAtLiterals<
  Tables extends KrvTables,
  E,
  Literals,
> = KrvTableValue<KrvTableAtLiterals<Tables, Literals>, E>;
export type KrvInputAtLiterals<
  Tables extends KrvTables,
  E,
  Literals,
> = KrvTableInputValue<KrvTableAtLiterals<Tables, Literals>, E>;
export type KrvWhereAtLiterals<
  Tables extends KrvTables,
  E,
  Literals,
> = KrvTableWhereValue<KrvTableAtLiterals<Tables, Literals>, E>;
export type KrvRowKeyAtLiterals<Tables extends KrvTables, Literals> = KrvRowKey<
  KrvTableAtLiterals<Tables, Literals>
>;

/** Top-level field names of the table at a key, for `db.compare`. */
export type KrvFieldAt<Tables extends KrvTables, E, Key> = keyof KrvValueAt<
  Tables,
  E,
  Key
> &
  string;

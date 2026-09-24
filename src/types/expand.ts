import type { KrvFieldName } from "./schema.ts";
import type {
  KrvTableLiterals,
  KrvTables,
  KrvTableValue,
  KrvTableWhereValue,
} from "./table.ts";

// ---- Names ----

type SplitDot<S extends string> = S extends `${infer H}.${infer R}`
  ? [H, ...SplitDot<R>]
  : [S];

type JoinDot<T> = T extends [infer H extends string]
  ? H
  : T extends [infer H extends string, ...infer R]
    ? `${H}.${JoinDot<R>}`
    : "";

type InitOf<T> = T extends [...infer I, unknown] ? I : [];

/** A table's name: its key's literal parts, joined by dots. */
export type KrvTableName<Table> =
  KrvTableLiterals<Table> extends readonly [...infer L] ? JoinDot<L> : never;

/** The table (of `Tables`) with this name. */
type TableByName<Tables extends KrvTables, Name> = TableByNameOf<
  Tables[number],
  Name
>;
type TableByNameOf<Table, Name> = Table extends unknown
  ? KrvTableName<Table> extends Name
    ? Table
    : never
  : never;

// ---- References ----

type SchemaOf<Table> = Table extends { readonly schema: infer S } ? S : never;
type KeyOf<Table> = Table extends { readonly key: infer K } ? K : never;

/** `"{authors.authorId}"` (or a union containing it) → `"authors.authorId"`. */
type RefString<V> = V extends `{${infer R}}`
  ? R extends `${string}.${string}`
    ? R
    : never
  : V extends readonly (infer U)[]
    ? RefString<U>
    : never;

/** A table's reference fields: field name → `"target.placeholder"`. */
type RefFields<Table> = {
  [
    K in keyof SchemaOf<Table> as [RefString<SchemaOf<Table>[K]>] extends [
      never,
    ]
      ? never
      : KrvFieldName<K>
  ]: RefString<SchemaOf<Table>[K]>;
};

type TargetName<Ref> = Ref extends string
  ? JoinDot<InitOf<SplitDot<Ref>>>
  : never;

type Placeholders<Key> = Key extends readonly (infer P)[]
  ? P extends `{${infer Name}}`
    ? Name
    : never
  : never;

/** `"books.authorId"` strings: fields of other tables that reference `Table`. */
type ReverseRefs<Tables extends KrvTables, Table> = ReverseRefsOf<
  Tables[number],
  Table
>;
type ReverseRefsOf<Source, Table> = Source extends unknown
  ? {
      [F in keyof RefFields<Source>]: TargetName<
        RefFields<Source>[F]
      > extends KrvTableName<Table>
        ? `${KrvTableName<Source>}.${F & string}`
        : never;
    }[keyof RefFields<Source>]
  : never;

type ForwardRefs<Table> = keyof RefFields<Table> & string;

// ---- Options ----

type Depth = unknown[];
type Next<D extends Depth> = [...D, unknown];

type ForwardEntry<
  Tables extends KrvTables,
  E,
  Table,
  F,
  D extends Depth,
> = F extends string
  ? {
      /** A reference field of this row: expands to the row it points to. */
      from: F;
      expand?: KrvExpand<
        Tables,
        E,
        TableByName<
          Tables,
          TargetName<RefFields<Table>[F & keyof RefFields<Table>]>
        >,
        Next<D>
      >;
    }
  : never;

type ReverseEntry<
  Tables extends KrvTables,
  E,
  R,
  D extends Depth,
> = R extends string
  ? ReverseEntryOf<
      Tables,
      E,
      R,
      TableByName<Tables, JoinDot<InitOf<SplitDot<R>>>>,
      D
    >
  : never;

type ReverseEntryOf<Tables extends KrvTables, E, R, Source, D extends Depth> = {
  /** `"<table>.<field>"` referencing this row: expands to those rows. */
  from: R;
  where?: KrvTableWhereValue<Source, E>;
  filter?: (row: KrvTableValue<Source, E>) => boolean;
  limit?: number;
  reverse?: boolean;
  expand?: KrvExpand<Tables, E, Source, Next<D>>;
};

type ExpandEntry<Tables extends KrvTables, E, Table, D extends Depth> =
  | ForwardRefs<Table>
  | ReverseRefs<Tables, Table>
  | ForwardEntry<Tables, E, Table, ForwardRefs<Table>, D>
  | ReverseEntry<Tables, E, ReverseRefs<Tables, Table>, D>;

/**
 * `expand` of a table: property name → what to expand into it. A field of
 * this row (`"authorId"`) gives one row; another table's field referencing
 * this one (`"books.authorId"`) gives a list. Names can't clash with fields.
 */
export type KrvExpand<
  Tables extends KrvTables,
  E,
  Table,
  D extends Depth = [],
> = D["length"] extends 4
  ? never
  : Record<string, ExpandEntry<Tables, E, Table, D>>;

// ---- Results ----

type FromOf<X> = X extends string ? X : X extends { from: infer F } ? F : never;
type NestedOf<X> = X extends { expand: infer N } ? N : Record<never, never>;

type ForwardResult<Tables extends KrvTables, E, Table, X> =
  TableByName<
    Tables,
    TargetName<RefFields<Table>[FromOf<X> & keyof RefFields<Table>]>
  > extends infer Target
    ? | KrvExpanded<Tables, E, Target, KrvTableValue<Target, E>, NestedOf<X>>
      | (null extends KrvTableValue<Table, E>[FromOf<X> &
          keyof KrvTableValue<Table, E>]
          ? null
          : undefined extends KrvTableValue<Table, E>[FromOf<X> &
                keyof KrvTableValue<Table, E>]
            ? null
            : never)
    : never;

type ReverseResult<Tables extends KrvTables, E, Table, X> =
  TableByName<
    Tables,
    JoinDot<InitOf<SplitDot<FromOf<X> & string>>>
  > extends infer Source
    ? KrvExpanded<
        Tables,
        E,
        Source,
        KrvTableValue<Source, E>,
        NestedOf<X>
      > extends infer Row
      ? // Keyed by the reference itself (1:1): at most one row.
        [Placeholders<KeyOf<Source>>] extends [Placeholders<KeyOf<Table>>]
        ? Row | null
        : Row[]
      : never
    : never;

type ExpandResult<Tables extends KrvTables, E, Table, X> =
  FromOf<X> extends `${string}.${string}`
    ? ReverseResult<Tables, E, Table, X>
    : ForwardResult<Tables, E, Table, X>;

// `& {}` flattens intersections in editor hovers.
// deno-lint-ignore ban-types
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/** Expanded names that clash with a field of the table: each one is an error. */
export type KrvExpandNoClash<X, Table, E> = {
  [K in Extract<keyof X, keyof KrvTableValue<Table, E>>]: never;
};

/** A row with its `expand`ed properties. */
export type KrvExpanded<Tables extends KrvTables, E, Table, Row, X> = [
  keyof X,
] extends [never]
  ? Row
  : Prettify<
      Row & { -readonly [N in keyof X]: ExpandResult<Tables, E, Table, X[N]> }
    >;

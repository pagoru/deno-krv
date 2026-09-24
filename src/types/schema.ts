/**
 * A value type in a schema:
 * - a type name: `"string"`, `"number"`, `"boolean"`, `"bigint"`, `"date"`,
 *   `"unknown"`, `"id"`, or a custom validator (`"email"`, `"str(3, 50)"`)
 * - a string literal: `"|draft|"`
 * - a key field `"{userId}"` or a reference `"{users.userId}"` (top level only)
 * - a raw literal: `1`, `true`, `null`, `undefined`
 * - a union: `["string", "number"]`
 * - a nested object: `{ street: "string" }`
 */
export type KrvSpec =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly KrvSpec[]
  | { readonly [field: string]: KrvSpec };

/**
 * Fields of a table or nested object. Field names carry modifiers:
 * `"name?"` optional, `"name[]"` array, `"name{}"` map, combined left to
 * right (`"name[]?"`, `"name{}[]"`).
 */
export type KrvSchemaDef = { readonly [field: string]: KrvSpec };

/** Argument value of a custom validator: `"str(3, |x|, true)"`. */
export type KrvValidatorArg = number | string | boolean | null;

/**
 * A custom validator: a base type, checked first, and a function that gets
 * the already typed value (and the arguments, if declared with any).
 */
export type KrvValidator = readonly [
  base: KrvSpec,
  check: (value: never, args: never) => boolean,
];

export type KrvValidators = Record<string, KrvValidator>;

// ---- Type inference ----

type Builtins = {
  string: string;
  number: number;
  boolean: boolean;
  bigint: bigint;
  date: Date;
  unknown: unknown;
  id: string;
};

export type KrvBuiltin = keyof Builtins;

/** No custom validators. */
export type KrvNoValidators = Record<never, never>;

// `& {}` flattens intersections in editor hovers.
// deno-lint-ignore ban-types
type Prettify<T> = { [K in keyof T]: T[K] } & {};

type Trim<S> = S extends ` ${infer R}`
  ? Trim<R>
  : S extends `${infer R} `
    ? Trim<R>
    : S;

type SplitParams<S> = S extends `${infer A},${infer R}`
  ? [Trim<A>, ...SplitParams<R>]
  : Trim<S> extends ""
    ? []
    : [Trim<S>];

/** `"str(min, max)"` → `"str"` */
type DeclName<K> = K extends `${infer N}(${string})` ? N : K;

/** `"str(min, max)"` → `["min", "max"]` */
type DeclParams<K> = K extends `${string}(${infer P})` ? SplitParams<P> : [];

/** Declaration key of the validator called `Name`. */
type FindValidator<Name, F> = {
  [K in keyof F]: DeclName<K> extends Name ? K : never;
}[keyof F];

type BaseOf<V> = V extends readonly [infer Base, unknown] ? Base : never;

type ArgsOf<V> = V extends readonly [
  unknown,
  (value: never, args: infer A) => boolean,
]
  ? A
  : never;

type StringSpecType<S extends string, F> = S extends KrvBuiltin
  ? Builtins[S]
  : S extends `|${infer L}|`
    ? L
    : S extends `{${string}}`
      ? string
      : S extends `${infer N}(${string})`
        ? ValidatorType<FindValidator<N, F>, F>
        : ValidatorType<FindValidator<S, F>, F>;

type ValidatorType<K, F> = [K] extends [never]
  ? never
  : K extends keyof F
    ? KrvSpecType<BaseOf<F[K]>, KrvNoValidators>
    : never;

/** TypeScript type of a value spec. `F` holds the custom validators. */
export type KrvSpecType<S, F> = S extends string
  ? StringSpecType<S, F>
  : S extends readonly (infer E)[]
    ? KrvSpecType<E, F>
    : S extends number | boolean | null | undefined
      ? S
      : S extends object
        ? KrvObjectType<S, F>
        : never;

/** `"tags[]?"` → `"tags"` */
export type KrvFieldName<K> = K extends `${infer R}?`
  ? KrvFieldName<R>
  : K extends `${infer R}[]`
    ? KrvFieldName<R>
    : K extends `${infer R}{}`
      ? KrvFieldName<R>
      : K;

/** Applies a field name's `[]` / `{}` modifiers to `T`. */
type Wrap<K, T> = K extends `${infer R}?`
  ? Wrap<R, T>
  : K extends `${infer R}[]`
    ? Wrap<R, T>[]
    : K extends `${infer R}{}`
      ? Record<string, Wrap<R, T>>
      : T;

type IsOptional<K, S, F> = K extends `${string}?`
  ? true
  : undefined extends KrvSpecType<S, F>
    ? true
    : false;

/** Generated when left out on insert: top-level `"id"` and `"{placeholder}"`. */
type IsGenerated<K, S> =
  K extends KrvFieldName<K>
    ? S extends "id"
      ? true
      : S extends `{${string}.${string}}`
        ? false
        : S extends `{${string}}`
          ? true
          : false
    : false;

type Field<K, S, F> = Wrap<K, KrvSpecType<S, F>>;

export type KrvObjectType<S, F> = Prettify<
  {
    -readonly [
      K in keyof S as IsOptional<K, S[K], F> extends true
        ? never
        : KrvFieldName<K>
    ]-?: Field<K, S[K], F>;
  } & {
    -readonly [
      K in keyof S as IsOptional<K, S[K], F> extends true
        ? KrvFieldName<K>
        : never
    ]?: Field<K, S[K], F>;
  }
>;

/** What `insert`/`set` accept: generated fields may be left out. */
export type KrvInputType<S, F> = Prettify<
  {
    -readonly [
      K in keyof S as IsOptional<K, S[K], F> extends true
        ? never
        : IsGenerated<K, S[K]> extends true
          ? never
          : KrvFieldName<K>
    ]-?: Field<K, S[K], F>;
  } & {
    -readonly [
      K in keyof S as IsOptional<K, S[K], F> extends true
        ? KrvFieldName<K>
        : IsGenerated<K, S[K]> extends true
          ? KrvFieldName<K>
          : never
    ]?: Field<K, S[K], F>;
  }
>;

// ---- Compile-time schema checking ----

type ArgTemplate<T> = [T] extends [never]
  ? AnyArgTemplate
  : unknown extends T
    ? AnyArgTemplate
    : | (T extends number ? `${number}` : never)
      | (T extends string ? `|${string}|` : never)
      | (T extends boolean ? `${T}` : never)
      | (T extends null ? "null" : never);

type AnyArgTemplate = `${number}` | `|${string}|` | "true" | "false" | "null";

type JoinArgs<Params, Args> = Params extends [infer P, ...infer Rest]
  ? Rest extends []
    ? ArgTemplate<P extends keyof Args ? Args[P] : never>
    : `${ArgTemplate<P extends keyof Args ? Args[P] : never>}, ${JoinArgs<
        Rest,
        Args
      >}`
  : "";

/** Every valid way to use the validators in `F`: `"email"`, `"str(${number}, ${number})"`. */
type ValidatorUsage<F> = {
  [K in keyof F & string]: DeclParams<K> extends []
    ? K
    : `${DeclName<K>}(${JoinArgs<DeclParams<K>, ArgsOf<F[K]>>})`;
}[keyof F & string];

type ValidString<F> =
  KrvBuiltin | `|${string}|` | `{${string}}` | ValidatorUsage<F>;

/** A value spec where every type name exists and every call is well-formed. */
export type KrvSpecFor<F> =
  | ValidString<F>
  | number
  | boolean
  | null
  | undefined
  | readonly KrvSpecFor<F>[]
  | { readonly [field: string]: KrvSpecFor<F> };

export type KrvSchemaFor<F> = { readonly [field: string]: KrvSpecFor<F> };

/**
 * The declaration shape `openKRV` expects for `validators`: the function's
 * value parameter is typed from the base.
 */
export type KrvValidatorDefs<V> = {
  [K in keyof V]: readonly [
    V[K],
    (value: KrvSpecType<V[K], KrvNoValidators>, args: never) => boolean,
  ];
};

// ---- Transforms ----

/**
 * What a transform character does with a field (declared in `openKRV`):
 * - `save`: the value to store instead of the plain one (can be async).
 * - `load`: restores the plain value on read. Without it, reads return what
 *   was stored (e.g. a hash).
 * - `compare`: checks a plain value against the stored one (`db.compare`).
 * - `deterministic`: the same input always gives the same output, so the
 *   field can be searched with `where` and indexed.
 */
export type KrvTransform = {
  // deno-lint-ignore no-explicit-any
  save: (value: any) => unknown;
  // deno-lint-ignore no-explicit-any
  load?: (stored: any) => unknown;
  // deno-lint-ignore no-explicit-any
  compare?: (plain: any, stored: any) => boolean | Promise<boolean>;
  deterministic?: boolean;
};

export type KrvTransforms = Record<string, KrvTransform>;

/** No transforms. */
export type KrvNoTransforms = Record<never, never>;

type Chars<T> = keyof T & string;

type StripOptional<K> = K extends `${infer R}?` ? R : K;

/** The transform character a top-level field name uses, if any. */
type CharOf<K, T> = {
  [C in Chars<T>]: StripOptional<K> extends `${string}${C}` ? C : never;
}[Chars<T>];

/** `"tokens[]&?"` → `"tokens[]"` */
type StripTransform<K, T> = [CharOf<K, T>] extends [never]
  ? StripOptional<K>
  : StripOptional<K> extends `${infer R}${CharOf<K, T>}`
    ? R
    : StripOptional<K>;

/** Name of a table's top-level field: `"tokens[]&?"` → `"tokens"`. */
export type KrvTopFieldName<K, T> = KrvFieldName<StripTransform<K, T>>;

/** Stored item type: a field whose transform has no `load` reads back as a string. */
type ItemOutput<K, S, V, T> = [CharOf<K, T>] extends [never]
  ? KrvSpecType<S, V>
  : T[CharOf<K, T> & keyof T] extends { load: (stored: never) => unknown }
    ? KrvSpecType<S, V>
    : string;

type TopField<K, S, V, T> = Wrap<StripTransform<K, T>, ItemOutput<K, S, V, T>>;
type TopFieldInput<K, S, V, T> = Wrap<StripTransform<K, T>, KrvSpecType<S, V>>;

type Timestamps<TS> = TS extends false
  ? KrvNoTransforms
  : { createdAt: number; updatedAt: number };

/** A table row as read back. `V`: validators, `T`: transforms, `TS`: timestamps. */
export type KrvTableRow<S, V, T, TS> = Prettify<
  {
    -readonly [
      K in keyof S as IsOptional<K, S[K], V> extends true
        ? never
        : KrvTopFieldName<K, T>
    ]-?: TopField<K, S[K], V, T>;
  } & {
    -readonly [
      K in keyof S as IsOptional<K, S[K], V> extends true
        ? KrvTopFieldName<K, T>
        : never
    ]?: TopField<K, S[K], V, T>;
  } & Timestamps<TS>
>;

/** What `insert`/`set` accept: plain values; generated fields and timestamps may be left out. */
export type KrvTableInput<S, V, T, TS> = Prettify<
  {
    -readonly [
      K in keyof S as IsOptional<K, S[K], V> extends true
        ? never
        : IsGenerated<K, S[K]> extends true
          ? never
          : KrvTopFieldName<K, T>
    ]-?: TopFieldInput<K, S[K], V, T>;
  } & {
    -readonly [
      K in keyof S as IsOptional<K, S[K], V> extends true
        ? KrvTopFieldName<K, T>
        : IsGenerated<K, S[K]> extends true
          ? KrvTopFieldName<K, T>
          : never
    ]?: TopFieldInput<K, S[K], V, T>;
  } & Partial<Timestamps<TS>>
>;

/** Nested objects in `where` match partially. */
type WhereValue<X> = X extends Date | Uint8Array | readonly unknown[]
  ? X
  : X extends object
    ? { [K in keyof X]?: WhereValue<X[K]> }
    : X;

/**
 * Fields `where` can compare: no transform, a deterministic one, or covered
 * by an index `using` a transform (`Using`).
 */
type Searchable<K, T, Using> = [CharOf<K, T>] extends [never]
  ? true
  : T[CharOf<K, T> & keyof T] extends { deterministic: true }
    ? true
    : KrvTopFieldName<K, T> extends Using
      ? true
      : false;

/** `where` of a table: equality on plain values, nested objects match partially. */
export type KrvTableWhere<S, V, T, TS, Using = never> = Prettify<
  {
    -readonly [
      K in keyof S as Searchable<K, T, Using> extends true
        ? KrvTopFieldName<K, T>
        : never
    ]?: WhereValue<TopFieldInput<K, S[K], V, T>>;
  } & Partial<Timestamps<TS>>
>;

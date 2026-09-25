export type KrvConsistency = "strong" | "eventual";

export type KrvGetOptions = {
  consistency?: KrvConsistency;
  /**
   * Include soft-deleted rows (with their `deletedAt`), and show references
   * to them as stored. Without it they're left out, and their optional
   * references read as `undefined` (or `null`) until purged. Default `false`.
   */
  deleted?: boolean;
};

export type KrvSetOptions<Field extends string = string> = {
  expireIn?: number;
  /**
   * Transformed fields whose values are already stored values (a hash,
   * ciphertext…), written as they are instead of through the transform.
   * Fields with a `load` are loaded first, so they must be readable with the
   * current secrets and are validated as plain values.
   */
  raw?: readonly Field[];
  /**
   * Only write if the key's current versionstamp matches.
   * `null` means "only write if the key doesn't exist yet".
   */
  check?: string | null;
};

export type KrvInsertOptions<Field extends string = string> = {
  expireIn?: number;
  /**
   * Transformed fields whose values are already stored values (a hash,
   * ciphertext…), written as they are instead of through the transform.
   * Fields with a `load` are loaded first, so they must be readable with the
   * current secrets and are validated as plain values.
   */
  raw?: readonly Field[];
};

export type KrvDeleteOptions = {
  /** Only delete if the key's current versionstamp matches. */
  check?: string | null;
  /**
   * Also delete every row that references this one, recursively.
   * Without it, deleting a referenced row throws (restrict). `"unset"`
   * clears the reference instead of deleting the row, where the field can be
   * empty: optional ones become undefined, `["{t.id}", null]` ones null.
   * Rows whose reference is required are still deleted.
   */
  cascade?: boolean | "unset";
  /**
   * Soft delete for this many milliseconds: the row is hidden from reads
   * (see `deleted`) and can be brought back with `restore`, then it expires.
   * Rows with a required reference to it are soft-deleted with it; optional
   * references read as unset, and are cleared for real by `purge`. Its unique
   * values stay taken meanwhile. `cascade` doesn't apply.
   */
  soft?: number;
};

export type KrvListOptions<Row, Where = { [K in keyof Row]?: Row[K] }> = {
  /**
   * Equality on top-level fields; nested objects match partially. Values of
   * transformed fields are transformed first, as if written. Key fields,
   * references and indexes narrow what's read; other fields are compared
   * while scanning.
   */
  where?: Where;
  /** Any condition, run on each row (after `where`, before `limit`). */
  filter?: (row: Row) => boolean;
  limit?: number;
  reverse?: boolean;
  consistency?: KrvConsistency;
  /** `false`: return `{ key, value, versionstamp }` entries instead of just the rows. Default `true`. */
  values?: boolean;
  /**
   * Include soft-deleted rows (with their `deletedAt`), and show references
   * to them as stored. Without it they're left out, and their optional
   * references read as `undefined` (or `null`) until purged. Default `false`.
   */
  deleted?: boolean;
};

export type KrvUpdateOptions<Field extends string = string> = {
  /** Only update if the row's current versionstamp matches. */
  check?: string;
  expireIn?: number;
  /**
   * Transformed fields whose values are already stored values (a hash,
   * ciphertext…), written as they are instead of through the transform.
   * Fields with a `load` are loaded first, so they must be readable with the
   * current secrets and are validated as plain values.
   */
  raw?: readonly Field[];
};

type Replaced = Date | Uint8Array | readonly unknown[];

/**
 * A partial row for `update`: nested objects are partial too (merged);
 * arrays and maps are replaced whole. `undefined` removes a field.
 */
export type KrvPatch<T> = {
  [K in keyof T]?: T[K] extends Replaced
    ? T[K] | undefined
    : T[K] extends object
      ? string extends keyof T[K]
        ? T[K] | undefined // a map: replaced
        : KrvPatch<T[K]> | undefined
      : T[K] | undefined;
};

/** Runtime shape of an `expand` entry (typed per table by `KrvExpand`). */
export type KrvExpandSpec =
  | string
  | {
      from: string;
      where?: Record<string, unknown>;
      filter?: (row: never) => boolean;
      limit?: number;
      reverse?: boolean;
      expand?: Record<string, KrvExpandSpec>;
    };

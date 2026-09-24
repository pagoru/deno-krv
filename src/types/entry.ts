import type { KrvKey } from "./key.ts";

export type KrvEntry<T, K = KrvKey> = {
  key: K;
  value: T;
  versionstamp: string;
};

export type KrvEntryMaybe<T, K = KrvKey> = KrvEntry<T, K> | {
  key: K;
  value: null;
  versionstamp: null;
};

/**
 * Result of `list` with `values: false`: `await` it for an array of entries,
 * or `for await` over it to stream them. Each use runs a fresh read.
 */
export type KrvListResult<T, K = KrvKey> =
  & AsyncIterable<KrvEntry<T, K>>
  & PromiseLike<KrvEntry<T, K>[]>;

/** Result of `list` (default): the rows only, no key or versionstamp. */
export type KrvValuesResult<T> = AsyncIterable<T> & PromiseLike<T[]>;

import type { KrvKey } from "./types/main.ts";
import { keyId } from "./registry.ts";

type Mutation =
  | { type: "set"; key: KrvKey; value: unknown; expireIn?: number }
  | { type: "delete"; key: KrvKey };

/**
 * Collects checks and mutations for one atomic commit, deduplicated by key.
 * A delete always wins over a set of the same key (e.g. a reference guard
 * touched by a child that is being cascaded together with its parent).
 */
export class WriteBatch {
  readonly #checks = new Map<string, Deno.AtomicCheck>();
  readonly #mutations = new Map<string, Mutation>();

  check(key: KrvKey, versionstamp: string | null): this {
    const id = keyId(key);
    if (!this.#checks.has(id)) this.#checks.set(id, { key, versionstamp });
    return this;
  }

  /**
   * `force` overrides an earlier delete of the same key (used for rows, which
   * may be moved onto a key freed in the same batch).
   */
  set(key: KrvKey, value: unknown, expireIn?: number, force = false): this {
    const id = keyId(key);
    if (force || this.#mutations.get(id)?.type !== "delete") {
      this.#mutations.set(id, { type: "set", key, value, expireIn });
    }
    return this;
  }

  delete(key: KrvKey): this {
    this.#mutations.set(keyId(key), { type: "delete", key });
    return this;
  }

  /** Whether this batch already sets or deletes `key`. */
  pending(key: KrvKey): Mutation["type"] | undefined {
    return this.#mutations.get(keyId(key))?.type;
  }

  build(kv: Deno.Kv): Deno.AtomicOperation {
    const operation = kv.atomic().check(...this.#checks.values());
    for (const mutation of this.#mutations.values()) {
      if (mutation.type === "set") {
        operation.set(mutation.key, mutation.value, {
          expireIn: mutation.expireIn,
        });
      } else {
        operation.delete(mutation.key);
      }
    }
    return operation;
  }
}

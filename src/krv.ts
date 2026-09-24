import type {
  KrvDatabase,
  KrvEnv,
  KrvEvents,
  KrvMigrationSource,
  KrvNoTransforms,
  KrvNoValidators,
  KrvSchemaFor,
  KrvSpec,
  KrvTable,
  KrvTransforms,
  KrvValidatorDefs,
  KrvValidators,
} from "./types/main.ts";
import { createRegistry } from "./registry.ts";
import { createDatabase, type DatabaseState } from "./database.ts";
import {
  acquireLock,
  hasBackup,
  isFilePath,
  prepare,
  restore,
} from "./migrate.ts";

/** Validators as seen by the types: base spec (from `V`) + function (from `F`). */
type ValidatorMap<V, F> = {
  [K in keyof V]: readonly [
    V[K],
    K extends keyof F ? F[K] extends readonly [unknown, infer Fn] ? Fn : never
      : never,
  ];
};

/** How long a lock can go untouched before it's considered abandoned. */
const DEFAULT_LOCK_TIMEOUT = 30_000;

/**
 * Opens a database.
 *
 * 1. Validators and transforms are registered, then every table is checked
 *    against them. Invalid schemas are compile errors, and throw
 *    `KrvSchemaError` at runtime.
 * 2. With a database file, `<path>.lock` is taken: only one process opens,
 *    migrates or checks at a time; others wait.
 * 3. Pending migrations run, sorted by id, after a backup of the file.
 * 4. Tables whose definition changed (all of them after a migration) have
 *    their rows checked and their indexes rebuilt. Any failure restores the
 *    backup and throws.
 *
 * @example
 * ```ts
 * const db = await openKRV({
 *   path: "./database",
 *   validators: {
 *     email: ["string", (v) => v.includes("@")],
 *   },
 *   transforms: {
 *     "#": { save: (v) => sha256(v), deterministic: true },
 *   },
 *   tables: [
 *     table({
 *       key: ["users", "{userId}"],
 *       schema: { id: "{userId}", "email#": "email", name: "string" },
 *       indexes: { byEmail: { fields: ["email"], unique: true } },
 *     }),
 *   ],
 *   migrations: [import("./migrations/2026-09-01--01-users.ts")],
 * });
 * ```
 */
export const openKRV = async <
  const V extends Record<string, KrvSpec> = KrvNoValidators,
  F extends { [K in keyof V]: readonly [unknown, unknown] } = {
    [K in keyof V]: readonly [unknown, unknown];
  },
  const T extends KrvTransforms = KrvNoTransforms,
  const Tables extends readonly KrvTable[] = readonly [],
>(
  options: {
    /** Database file, or `":memory:"`. Omit for Deno's default location. */
    path?: string;
    /**
     * Custom types: `name: [baseType, (value) => boolean]`, or with
     * arguments `"name(a, b)": [baseType, (value, { a, b }) => boolean]`.
     */
    validators?: KrvValidatorDefs<V> & F;
    /**
     * What a field name's transform character stores instead of the plain
     * value: `"*": { save, compare }`, `"&": { save, load }`,
     * `"#": { save, deterministic: true }`.
     */
    transforms?: T & KrvTransforms;
    /**
     * The tables, each named by its key's literal parts (`["posts", "{id}"]`
     * is `posts`). Checked against `validators` once they are inferred.
     */
    tables: {
      [I in keyof Tables]:
        & Tables[I]
        & KrvTable<readonly string[], KrvSchemaFor<ValidatorMap<V, F>>>;
    };
    /** Migrations, run in id order: objects or modules (`import("./m.ts")`). */
    migrations?: KrvMigrationSource[];
    /** Migration lifecycle hooks, awaited. */
    events?: KrvEvents;
    /** Milliseconds before an untouched lock file is taken over. Default 30s. */
    lockTimeout?: number;
  },
): Promise<KrvDatabase<Tables, KrvEnv<ValidatorMap<V, F>, T>>> => {
  const { path } = options;
  const validators = options.validators as unknown as KrvValidators | undefined;
  const registry = createRegistry(
    options.tables as unknown as readonly KrvTable[],
    validators,
    options.transforms,
  );

  const release = isFilePath(path)
    ? await acquireLock(path, options.lockTimeout ?? DEFAULT_LOCK_TIMEOUT)
    : async () => {};

  try {
    // A backup left behind means a migration crashed halfway: undo it.
    if (isFilePath(path) && await hasBackup(path)) await restore(path);

    const state: DatabaseState = { kv: await Deno.openKv(path) };
    const db = createDatabase<Tables, KrvEnv<ValidatorMap<V, F>, T>>(
      state,
      registry,
    );
    try {
      await prepare(state, registry, db as never, {
        path,
        validators,
        migrations: options.migrations ?? [],
        events: options.events ?? {},
      });
    } catch (error) {
      state.kv.close();
      throw error;
    }
    return db;
  } finally {
    await release();
  }
};

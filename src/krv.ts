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
  KrvTables,
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
import {
  createDefaultTransforms,
  DEFAULT_TRANSFORM_SECRETS,
  type KrvWithDefaultTransforms,
} from "./transforms.ts";
import { type KrvSecrets, loadSecrets } from "./secrets.ts";

/** Validators as seen by the types: base spec (from `V`) + function (from `F`). */
type ValidatorMap<V, F> = {
  [K in keyof V]: readonly [
    V[K],
    K extends keyof F
      ? F[K] extends readonly [unknown, infer Fn]
        ? Fn
        : never
      : never,
  ];
};

/** Validators and transforms (defaults included) as seen by the row types. */
type Env<V, F, T> = KrvEnv<ValidatorMap<V, F>, KrvWithDefaultTransforms<T>>;

/** What `defineKRV` takes: the schema part of `openKRV`'s options. */
export type KrvConfig<V, F, T, Tables extends readonly unknown[]> = {
  /**
   * Custom types: `name: [baseType, (value) => boolean]`, or with
   * arguments `"name(a, b)": [baseType, (value, { a, b }) => boolean]`.
   */
  validators?: KrvValidatorDefs<V> & F;
  /**
   * What a field name's transform character stores instead of the plain
   * value: `"*": { save, compare }`, `"&": { save, load }`,
   * `"#": { save, deterministic: true }`. `#` (HMAC-SHA256), `*` (peppered
   * bcrypt) and `&` (AES-256-GCM) are built in; declaring them here replaces
   * them.
   */
  transforms?: T & KrvTransforms;
  /**
   * The tables, each named by its key's literal parts (`["posts", "{id}"]`
   * is `posts`). Checked against `validators` once they are inferred.
   * Default none.
   */
  tables?: {
    [I in keyof Tables]: Tables[I] &
      KrvTable<readonly string[], KrvSchemaFor<ValidatorMap<V, F>>>;
  };
};

/**
 * A `defineKRV` result: its options as inferred, so `openKRV` infers them the
 * same way again when they're spread into it.
 */
export type KrvDefinedConfig<F, T, Tables> = {
  validators?: F;
  transforms?: T;
  tables?: Tables;
};

/** Types carried by a `defineKRV` result, read by `KrvDatabaseOf`. */
export type KrvConfigTypes<Tables extends KrvTables, E> = {
  readonly "~krv"?: { tables: Tables; env: E };
};

/**
 * The database type of a `defineKRV` config, e.g. for migrations:
 * `KrvMigration<KrvDatabaseOf<typeof config>>`.
 */
export type KrvDatabaseOf<C> = C extends {
  readonly "~krv"?: { tables: infer Tables extends KrvTables; env: infer E };
}
  ? KrvDatabase<Tables, E>
  : never;

/**
 * Declares tables, validators and transforms apart from `openKRV`, so their
 * database type can be named without opening it (`KrvDatabaseOf`). Useful
 * where `openKRV`'s own result can't be used, like in migrations, which it
 * imports. Pass it to `openKRV` spread: `openKRV({ ...config, path })`.
 *
 * @example
 * ```ts
 * // db/config.ts
 * export const config = defineKRV({ tables: [users, posts] });
 * export type Db = KrvDatabaseOf<typeof config>;
 *
 * // db/migrations/2026-09-24--001--names.ts
 * export default {
 *   url: import.meta.url,
 *   up: async (db) => { await db.insert(["users"], { name: "ana" }); }, // typed
 * } satisfies KrvMigration<Db>;
 * ```
 */
export const defineKRV = <
  const V extends Record<string, KrvSpec> = KrvNoValidators,
  F extends { [K in keyof V]: readonly [unknown, unknown] } = {
    [K in keyof V]: readonly [unknown, unknown];
  },
  const T extends KrvTransforms = KrvNoTransforms,
  const Tables extends readonly KrvTable[] = readonly [],
>(
  config: KrvConfig<V, F, T, Tables>,
): KrvDefinedConfig<F, T, Tables> & KrvConfigTypes<Tables, Env<V, F, T>> =>
  config as KrvDefinedConfig<F, T, Tables>;

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
 * 3. Pending migrations run, by the date and number in their file name,
 *    after a backup of the file.
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
 *   tables: [
 *     table({
 *       key: ["users", "{userId}"],
 *       // "#" (SHA-256) and "*" (bcrypt) are built-in transforms.
 *       schema: { id: "{userId}", "email#": "email", "password*": "string" },
 *       indexes: { byEmail: { fields: ["email"], unique: true } },
 *     }),
 *   ],
 *   migrations: [import("./migrations/2026-09-01--001--users.ts")],
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
>(options: {
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
   * `"#": { save, deterministic: true }`. `#` (HMAC-SHA256), `*` (peppered
   * bcrypt) and `&` (AES-256-GCM) are built in; declaring them here replaces
   * them.
   */
  transforms?: T & KrvTransforms;
  /**
   * The tables, each named by its key's literal parts (`["posts", "{id}"]`
   * is `posts`). Checked against `validators` once they are inferred.
   * Default none.
   */
  tables?: {
    [I in keyof Tables]: Tables[I] &
      KrvTable<readonly string[], KrvSchemaFor<ValidatorMap<V, F>>>;
  };
  /**
   * Migrations, as modules: `[import("./migrations/2026-09-24--001--users.ts")]`.
   * Each file's name (from `url: import.meta.url`) orders them: by date,
   * then number.
   */
  migrations?: KrvMigrationSource[];
  /** Migration lifecycle hooks, awaited. */
  events?: KrvEvents;
  /**
   * Key (`#`, `&`) and pepper (`*`) of the built-in transforms. By default
   * they're kept in the binary `<path>.secrets`, created on first open; pass
   * them when there's no database file (Deno's default location).
   */
  secrets?: KrvSecrets;
  /** Milliseconds before an untouched lock file is taken over. Default 30s. */
  lockTimeout?: number;
}): Promise<KrvDatabase<Tables, Env<V, F, T>>> => {
  const { path } = options;
  const validators = options.validators as unknown as KrvValidators | undefined;
  // Loaded once the lock is held, so only one process creates them.
  let secrets: Partial<KrvSecrets> = {};
  const registry = createRegistry(
    (options.tables ?? []) as unknown as readonly KrvTable[],
    validators,
    { ...createDefaultTransforms(() => secrets), ...options.transforms },
  );

  const release = isFilePath(path)
    ? await acquireLock(path, options.lockTimeout ?? DEFAULT_LOCK_TIMEOUT)
    : async () => {};

  try {
    // A backup left behind means a migration crashed halfway: undo it.
    if (isFilePath(path) && (await hasBackup(path))) await restore(path);

    // Only needed while a built-in transform isn't replaced.
    secrets = await loadSecrets(
      path,
      options.secrets,
      Object.keys(DEFAULT_TRANSFORM_SECRETS).some(
        (char) => !options.transforms?.[char],
      ),
    );

    const state: DatabaseState = { kv: await Deno.openKv(path) };
    const db = createDatabase<Tables, Env<V, F, T>>(state, registry);
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

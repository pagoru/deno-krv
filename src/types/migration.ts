import type { KrvListResult } from "./entry.ts";
import type { KrvKey } from "./key.ts";
import type {
  KrvDeleteOptions,
  KrvGetOptions,
  KrvInsertOptions,
  KrvListOptions,
  KrvSetOptions,
  KrvUpdateOptions,
} from "./options.ts";
import type { KrvTransforms } from "./schema.ts";

/**
 * The database API with loosely typed rows: what a migration's `db` is when
 * `KrvMigration` isn't given your database's type.
 */
export type KrvUntypedDb = {
  // deno-lint-ignore no-explicit-any
  get(key: KrvKey, options?: KrvGetOptions): Promise<any>;
  set(
    key: KrvKey,
    // deno-lint-ignore no-explicit-any
    value: any,
    options?: KrvSetOptions,
    // deno-lint-ignore no-explicit-any
  ): Promise<any>;
  insert(
    literals: KrvKey,
    // deno-lint-ignore no-explicit-any
    value: any,
    options?: KrvInsertOptions,
    // deno-lint-ignore no-explicit-any
  ): Promise<any>;
  update(
    key: KrvKey,
    // deno-lint-ignore no-explicit-any
    patch: any,
    options?: KrvUpdateOptions,
    // deno-lint-ignore no-explicit-any
  ): Promise<any>;
  delete(key: KrvKey, options?: KrvDeleteOptions): Promise<void>;
  restore(key: KrvKey): Promise<void>;
  purge(): Promise<number>;
  list(
    literals: KrvKey,
    // deno-lint-ignore no-explicit-any
    options?: KrvListOptions<any, any>,
    // deno-lint-ignore no-explicit-any
  ): KrvListResult<any>;
  find(
    literals: KrvKey,
    // deno-lint-ignore no-explicit-any
    options?: Omit<KrvListOptions<any, any>, "limit">,
    // deno-lint-ignore no-explicit-any
  ): Promise<any | null>;
  compare(key: KrvKey, field: string, plain: unknown): Promise<boolean>;
};

/**
 * The database inside a migration's `up`: `Db` (your database's type, or
 * loosely typed rows by default), plus raw access and the transforms.
 */
export type KrvMigrationDb<Db = KrvUntypedDb> = Omit<
  Db,
  "raw" | "transforms" | "close"
> & {
  /**
   * The underlying `Deno.Kv`: no schemas, validation, transforms, indexes or
   * timestamps. Use it to read and rewrite data in an old shape. Indexes of
   * every table are rebuilt after the migrations.
   */
  raw: Deno.Kv;
  /**
   * Your transforms, by character, e.g. `db.transforms["&"].save(value)`.
   * `db.raw` skips them, so call them yourself when writing raw data.
   */
  transforms: KrvTransforms;
};

/**
 * A migration: the default export of a file named
 * `YYYY-MM-DD--NNN[--name].ts`. The file name is its identity: migrations run
 * by date, then by number.
 *
 * @example
 * ```ts
 * // migrations/2026-09-24--001--add-age.ts
 * export default {
 *   url: import.meta.url,
 *   up: async (db) => { … },
 * } satisfies KrvMigration;
 * ```
 */
export type KrvMigration<Db = KrvUntypedDb> = {
  /**
   * `import.meta.url`: where the file name is read from. Only the name is
   * kept, not the path.
   */
  url: string;
  description?: string;
  /** `false`: skipped and not recorded, so it runs once enabled. Default `true`. */
  enabled?: boolean;
  up: (db: KrvMigrationDb<Db>) => unknown;
};

/** A migration typed with any database: `up` takes whatever its `Db` is. */
type AnyMigration = Omit<KrvMigration, "up"> & { up: (db: never) => unknown };

/** A migration, or a module exporting one as default (`import("./m.ts")`). */
export type KrvMigrationSource =
  | AnyMigration
  | { default: AnyMigration }
  | Promise<AnyMigration | { default: AnyMigration }>;

/** A migration as loaded, with what its file name says. */
export type KrvLoadedMigration = AnyMigration & {
  /**
   * `YYYY-MM-DD--NNN`: what's recorded once applied, so renaming the name
   * part of the file doesn't run it again.
   */
  id: string;
  /** The file name without extension, e.g. `2026-09-24--001--users`. */
  fileName: string;
  /** The optional name part, e.g. `users`. */
  name?: string;
};

/** Applied migrations, stored in `["__krv", "migrations", id]`. Only the name, never the path. */
export type KrvAppliedMigration = {
  id: string;
  fileName: string;
  description?: string;
  appliedAt: number;
  durationMs: number;
};

/** Migration lifecycle hooks. Each is awaited; a throw fails the migrations. */
export type KrvEvents = {
  /** After the backup exists, before the first pending migration runs. */
  beforeMigrations?: (event: {
    pending: KrvLoadedMigration[];
    backupPath: string | null;
  }) => unknown;
  beforeMigration?: (event: { migration: KrvLoadedMigration }) => unknown;
  afterMigration?: (event: {
    migration: KrvLoadedMigration;
    durationMs: number;
  }) => unknown;
  /** After the backup has been restored. `migration` is null if the failure came later (checks). */
  migrationFailed?: (event: {
    migration: KrvLoadedMigration | null;
    error: unknown;
    backupPath: string | null;
  }) => unknown;
  afterMigrations?: (event: { applied: KrvLoadedMigration[] }) => unknown;
};

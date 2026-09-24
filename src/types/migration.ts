import type { KrvCommitResult } from "./commit.ts";
import type { KrvEntryMaybe, KrvListResult } from "./entry.ts";
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
 * The database inside a migration's `up`. Rows are loosely typed, because a
 * migration usually moves data between shapes.
 */
export type KrvMigrationDb = {
  // deno-lint-ignore no-explicit-any
  get(key: KrvKey, options?: KrvGetOptions): Promise<KrvEntryMaybe<any>>;
  set(
    key: KrvKey,
    // deno-lint-ignore no-explicit-any
    value: any,
    options?: KrvSetOptions,
  ): Promise<KrvCommitResult>;
  insert(
    literals: KrvKey,
    // deno-lint-ignore no-explicit-any
    value: any,
    options?: KrvInsertOptions,
    // deno-lint-ignore no-explicit-any
  ): Promise<KrvCommitResult & { key: KrvKey; value: any }>;
  update(
    key: KrvKey,
    // deno-lint-ignore no-explicit-any
    patch: any,
    options?: KrvUpdateOptions,
    // deno-lint-ignore no-explicit-any
  ): Promise<any>;
  delete(key: KrvKey, options?: KrvDeleteOptions): Promise<void>;
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

export type KrvMigration = {
  /** Unique id. Migrations run sorted by id: start it with a date. */
  id: string;
  description?: string;
  /** `false`: skipped and not recorded, so it runs once enabled. Default `true`. */
  enabled?: boolean;
  up: (db: KrvMigrationDb) => unknown;
};

/** A migration, or a module exporting one as default (`import("./m.ts")`). */
export type KrvMigrationSource =
  | KrvMigration
  | { default: KrvMigration }
  | Promise<KrvMigration | { default: KrvMigration }>;

/** Applied migrations, stored in `["__krv", "migrations", id]`. */
export type KrvAppliedMigration = {
  id: string;
  description?: string;
  appliedAt: number;
  durationMs: number;
};

/** Migration lifecycle hooks. Each is awaited; a throw fails the migrations. */
export type KrvEvents = {
  /** After the backup exists, before the first pending migration runs. */
  beforeMigrations?: (event: {
    pending: KrvMigration[];
    backupPath: string | null;
  }) => unknown;
  beforeMigration?: (event: { migration: KrvMigration }) => unknown;
  afterMigration?: (event: {
    migration: KrvMigration;
    durationMs: number;
  }) => unknown;
  /** After the backup has been restored. `migration` is null if the failure came later (checks). */
  migrationFailed?: (event: {
    migration: KrvMigration | null;
    error: unknown;
    backupPath: string | null;
  }) => unknown;
  afterMigrations?: (event: { applied: KrvMigration[] }) => unknown;
};

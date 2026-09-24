import type {
  KrvAppliedMigration,
  KrvEvents,
  KrvKey,
  KrvMigration,
  KrvMigrationDb,
  KrvMigrationSource,
  KrvValidators,
} from "./types/main.ts";
import type { DatabaseState } from "./database.ts";
import {
  type createRegistry,
  indexKey,
  INTERNAL,
  keyId,
  keyToString,
  type ParsedTable,
  secondaryPrefix,
  uniqueKey,
} from "./registry.ts";
import { KrvSchemaError } from "./schema.ts";
import { loadRow } from "./values.ts";

type Row = Record<string, unknown>;
type Registry = ReturnType<typeof createRegistry>;

/** Mutations per atomic commit while rebuilding (Deno KV allows 1000). */
const CHUNK = 500;
/** Invalid rows reported per table. */
const MAX_ISSUES = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const exists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

const removeIfExists = async (path: string) => {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};

/** A path to a database file (not `:memory:`, a remote URL, or the default). */
export const isFilePath = (path: string | undefined): path is string =>
  path !== undefined && path !== ":memory:" && !/^https?:\/\//.test(path);

// ---- Lock file ----

/**
 * Takes `<path>.lock`, waiting while another process holds it. The holder
 * touches the file every `staleMs / 3`; a lock untouched for `staleMs` was
 * left by a crashed process and is taken over.
 *
 * @returns A function releasing the lock.
 */
export const acquireLock = async (
  path: string,
  staleMs: number,
): Promise<() => Promise<void>> => {
  const file = `${path}.lock`;
  while (true) {
    try {
      await Deno.writeTextFile(file, String(Deno.pid), { createNew: true });
      break;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    try {
      const { mtime } = await Deno.stat(file);
      if (mtime && Date.now() - mtime.getTime() > staleMs) {
        await removeIfExists(file);
        continue;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      continue;
    }
    await sleep(50);
  }

  const heartbeat = setInterval(
    () => {
      const now = new Date();
      Deno.utime(file, now, now).catch(() => {});
    },
    Math.max(10, staleMs / 3),
  );

  return async () => {
    clearInterval(heartbeat);
    await removeIfExists(file);
  };
};

// ---- Backup ----

/** SQLite keeps its data in the file and, while open, these two next to it. */
const SIDECARS = ["", "-wal", "-shm"];

export const backupPath = (path: string) => `${path}.backup`;

/** Copies the (closed) database to `<path>.backup`. */
export const backup = async (path: string) => {
  for (const suffix of SIDECARS) {
    await removeIfExists(backupPath(path) + suffix);
    if (await exists(path + suffix)) {
      await Deno.copyFile(path + suffix, backupPath(path) + suffix);
    }
  }
};

/** Puts `<path>.backup` back in place of the (closed) database. */
export const restore = async (path: string) => {
  for (const suffix of SIDECARS) await removeIfExists(path + suffix);
  for (const suffix of SIDECARS) {
    if (await exists(backupPath(path) + suffix)) {
      await Deno.rename(backupPath(path) + suffix, path + suffix);
    }
  }
};

export const removeBackup = async (path: string) => {
  for (const suffix of SIDECARS) {
    await removeIfExists(backupPath(path) + suffix);
  }
};

export const hasBackup = (path: string) => exists(backupPath(path));

// ---- Fingerprints ----

/** JSON with sorted keys and distinct `undefined`, so equal schemas hash equal. */
const stable = (value: unknown): string => {
  if (value === undefined) return '"\\u0000undefined"';
  if (typeof value === "function") return JSON.stringify(String(value));
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Row)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256 = async (text: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

/** Changes whenever the table, or any validator or transform, changes. */
export const fingerprint = (
  table: ParsedTable,
  validators: KrvValidators | undefined,
  registry: Registry,
) =>
  sha256(
    stable({
      key: table.table.key,
      schema: table.table.schema,
      timestamps: table.timestamps,
      indexes: table.table.indexes ?? {},
      validators: validators ?? {},
      transforms: registry.transforms,
    }),
  );

const schemaKey = (table: string) => [INTERNAL, "schema", table];
const migrationKey = (id: string) => [INTERNAL, "migrations", id];

// ---- Checks and index rebuilds ----

/** Every row of `table`, stored values. */
async function* rows(kv: Deno.Kv, registry: Registry, table: ParsedTable) {
  const prefix: string[] = [];
  for (const part of table.pattern) {
    if (!("literal" in part)) break;
    prefix.push(part.literal);
  }
  for await (const entry of kv.list<Row>({ prefix })) {
    if (entry.key[0] === INTERNAL || !registry.matches(table, entry.key)) {
      continue;
    }
    yield entry;
  }
}

/** Rows that don't match their table's schema, as issue lines by table. */
const checkRows = async (
  kv: Deno.Kv,
  registry: Registry,
  tables: ParsedTable[],
) => {
  const report: string[] = [];
  for (const table of tables) {
    const issues: string[] = [];
    let invalid = 0;
    for await (const entry of rows(kv, registry, table)) {
      let found: string[];
      try {
        const value = await loadRow(table, entry.value);
        found = table.schema.checkExcept(
          value,
          keyToString(entry.key),
          table.opaque,
        );
      } catch (error) {
        found = [
          `${keyToString(entry.key)}: can't load a transformed field (${
            error instanceof Error ? error.message : error
          })`,
        ];
      }
      if (!found.length) continue;
      invalid++;
      if (issues.length < MAX_ISSUES) issues.push(...found);
    }
    if (invalid) {
      report.push(
        `Table "${table.name}": ${invalid} invalid row(s)`,
        ...issues.map((issue) => `  - ${issue}`),
      );
    }
  }
  return report;
};

const deletePrefix = async (kv: Deno.Kv, prefix: KrvKey) => {
  let keys: Deno.KvKey[] = [];
  const flush = async () => {
    const op = kv.atomic();
    for (const key of keys) op.delete(key);
    await op.commit();
    keys = [];
  };
  for await (const { key } of kv.list({ prefix })) {
    keys.push(key);
    if (keys.length === CHUNK) await flush();
  }
  if (keys.length) await flush();
};

/** Drops a table's index entries (secondary, unique, references). */
const dropIndexes = async (kv: Deno.Kv, table: string) => {
  await deletePrefix(kv, [INTERNAL, "idx", table]);
  await deletePrefix(kv, [INTERNAL, "uniq", table]);
  await deletePrefix(kv, [INTERNAL, "index", table]);
};

/**
 * Rebuilds the index entries of `tables` from their rows. Checks unique
 * values and references first, so nothing is written if they're broken.
 */
const rebuildIndexes = async (
  kv: Deno.Kv,
  registry: Registry,
  tables: ParsedTable[],
) => {
  const report: string[] = [];
  const writes: [KrvKey, unknown][] = [];

  for (const table of tables) {
    const issues: string[] = [];
    const seen = new Map<string, KrvKey>();
    for await (const { key, value } of rows(kv, registry, table)) {
      for (const index of table.indexes) {
        const values = await registry.indexValues(table, index, value);
        if (!values) continue;
        if (!index.unique) {
          writes.push([
            [...secondaryPrefix(table.name, index.name, values), ...key],
            null,
          ]);
          continue;
        }
        const id = `${index.name}:${keyId(values)}`;
        const owner = seen.get(id);
        if (owner) {
          issues.push(
            `${keyToString(key)}: ${index.name} (${index.fields.join(
              ", ",
            )}) duplicates ${keyToString(owner)}`,
          );
          continue;
        }
        seen.set(id, key);
        writes.push([uniqueKey(table.name, index.name, values), key]);
      }

      for (const reference of table.references) {
        const target = registry.targetKey(reference, value);
        if (!target) continue;
        if ((await kv.get(target)).versionstamp === null) {
          issues.push(
            `${keyToString(key)}: ${reference.field} references missing ${keyToString(
              target,
            )}`,
          );
          continue;
        }
        writes.push([indexKey(table.name, reference.field, target, key), null]);
      }
    }
    if (issues.length) {
      report.push(
        `Table "${table.name}": ${issues.length} broken index or reference value(s)`,
        ...issues.slice(0, MAX_ISSUES).map((issue) => `  - ${issue}`),
      );
    }
  }
  if (report.length) return report;

  for (const table of tables) await dropIndexes(kv, table.name);
  for (let i = 0; i < writes.length; i += CHUNK) {
    const op = kv.atomic();
    for (const [key, value] of writes.slice(i, i + CHUNK)) op.set(key, value);
    await op.commit();
  }
  return report;
};

// ---- Migrations ----

const loadMigrations = async (sources: KrvMigrationSource[]) => {
  const migrations: KrvMigration[] = [];
  for (const source of sources) {
    const loaded = await source;
    const migration = "default" in loaded ? loaded.default : loaded;
    if (!migration?.id || typeof migration.up !== "function") {
      throw new KrvSchemaError(
        `Invalid migration: needs an "id" and an "up" function`,
      );
    }
    if (migrations.some((m) => m.id === migration.id)) {
      throw new KrvSchemaError(`Migration "${migration.id}" is declared twice`);
    }
    migrations.push(migration);
  }
  return migrations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

export type PrepareOptions = {
  path: string | undefined;
  validators: KrvValidators | undefined;
  migrations: KrvMigrationSource[];
  events: KrvEvents;
};

/**
 * Runs pending migrations, then checks the rows of tables whose definition
 * changed (every table, if a migration ran) and rebuilds their indexes.
 * With a database file, a failure restores the backup taken before the
 * migrations. Runs under the lock.
 */
export const prepare = async (
  state: DatabaseState,
  registry: Registry,
  db: Omit<KrvMigrationDb, "raw" | "transforms">,
  options: PrepareOptions,
) => {
  const { path, events } = options;
  const migrations = await loadMigrations(options.migrations);

  const applied = new Set<string>();
  for await (const { value } of state.kv.list<KrvAppliedMigration>({
    prefix: [INTERNAL, "migrations"],
  }))
    applied.add(value.id);
  const pending = migrations.filter(
    (m) => m.enabled !== false && !applied.has(m.id),
  );

  const stored = new Map<string, string>();
  for await (const { key, value } of state.kv.list<string>({
    prefix: [INTERNAL, "schema"],
  }))
    stored.set(String(key[2]), value);

  const current = new Map<string, string>();
  for (const table of registry.tables) {
    current.set(
      table.name,
      await fingerprint(table, options.validators, registry),
    );
  }
  const changed = registry.tables.filter(
    (t) => stored.get(t.name) !== current.get(t.name),
  );
  const removed = [...stored.keys()].filter((name) => !current.has(name));

  if (!pending.length && !changed.length && !removed.length) return;

  const file = pending.length && isFilePath(path) ? path : null;
  const backupFile = file ? backupPath(file) : null;
  if (file) {
    state.kv.close();
    await backup(file);
    state.kv = await Deno.openKv(file);
  }

  const migrationDb: KrvMigrationDb = {
    ...db,
    get raw() {
      return state.kv;
    },
    transforms: registry.transforms,
  };

  let running: KrvMigration | null = null;
  try {
    if (pending.length) {
      await events.beforeMigrations?.({ pending, backupPath: backupFile });
    }
    for (const migration of pending) {
      running = migration;
      await events.beforeMigration?.({ migration });
      const start = performance.now();
      await migration.up(migrationDb);
      const durationMs = Math.round(performance.now() - start);
      await state.kv.set(migrationKey(migration.id), {
        id: migration.id,
        description: migration.description,
        appliedAt: Date.now(),
        durationMs,
      } satisfies KrvAppliedMigration);
      await events.afterMigration?.({ migration, durationMs });
    }
    running = null;

    const tables = pending.length ? registry.tables : changed;
    const invalid = await checkRows(state.kv, registry, tables);
    if (invalid.length) {
      throw new KrvSchemaError(
        `Stored rows don't match their tables${
          pending.length ? " after migrations" : ""
        }. Add or fix a migration:\n${invalid.join("\n")}`,
      );
    }

    const broken = await rebuildIndexes(state.kv, registry, tables);
    if (broken.length) {
      throw new KrvSchemaError(
        `Indexes can't be built for the stored rows:\n${broken.join("\n")}`,
      );
    }
    for (const name of removed) {
      await dropIndexes(state.kv, name);
      await state.kv.delete(schemaKey(name));
    }
    for (const [name, hash] of current) {
      await state.kv.set(schemaKey(name), hash);
    }

    if (pending.length) await events.afterMigrations?.({ applied: pending });
  } catch (error) {
    if (file) {
      state.kv.close();
      await restore(file);
      state.kv = await Deno.openKv(file);
    }
    if (pending.length) {
      await events.migrationFailed?.({
        migration: running,
        error,
        backupPath: backupFile,
      });
    }
    throw error;
  }

  if (file) await removeBackup(file);
};

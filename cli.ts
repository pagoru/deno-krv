/**
 * Command line tools, for development.
 *
 * ```sh
 * deno run -RW jsr:@da/deno-krv/cli new-migration "first migration"
 * # Created migrations/2026-09-24--001--first-migration.ts
 * ```
 *
 * `--dir=<path>` changes the folder (default `migrations`). The number is the
 * next one for today among the files there; `--number=N` sets it instead,
 * without reading the folder.
 *
 * @module
 */
import {
  MIGRATION_EXTENSIONS,
  nextMigrationName,
} from "./src/migration-name.ts";

const USAGE = `Usage: new-migration [name] [--dir=migrations] [--number=N]`;

/** A new, empty migration to fill in. */
export const migrationTemplate = (): string =>
  `import type { KrvMigration } from "@da/deno-krv";

export default {
  url: import.meta.url, // the file name identifies the migration
  up: async (db) => {
    // db.raw is the plain Deno.Kv; the usual API works too.
  },
} satisfies KrvMigration;
`;

const listScripts = async (dir: string): Promise<string[]> => {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && MIGRATION_EXTENSIONS.test(entry.name)) {
        names.push(entry.name);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names;
};

/**
 * Creates `<dir>/<YYYY-MM-DD--NNN--name>.ts`, numbered `number`, or after
 * today's migrations already in `dir`.
 *
 * @returns The path of the new migration.
 */
export const newMigration = async (
  name?: string,
  dir = "migrations",
  number?: number,
): Promise<string> => {
  const base = dir.replace(/\/+$/, "");
  const next = nextMigrationName(
    number === undefined ? await listScripts(base) : [],
    name,
    new Date(),
    number,
  );
  const file = `${base}/${next}.ts`;
  await Deno.mkdir(base, { recursive: true });
  await Deno.writeTextFile(file, migrationTemplate(), { createNew: true });
  return file;
};

if (import.meta.main) {
  const [command, ...rest] = Deno.args;
  const dir = rest.find((a) => a.startsWith("--dir="))?.slice("--dir=".length);
  const name = rest.filter((a) => !a.startsWith("--")).join(" ") || undefined;
  const number = rest
    .find((a) => a.startsWith("--number="))
    ?.slice("--number=".length);

  if (command !== "new-migration") {
    console.error(USAGE);
    Deno.exit(1);
  }
  if (number !== undefined && !/^\d{1,3}$/.test(number)) {
    console.error(`--number must be 1 to 999\n${USAGE}`);
    Deno.exit(1);
  }
  const file = await newMigration(
    name,
    dir,
    number === undefined ? undefined : +number,
  );
  console.log(`Created ${file}`);
}

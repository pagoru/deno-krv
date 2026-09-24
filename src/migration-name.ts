/**
 * A migration's file name (without extension): `YYYY-MM-DD--NNN--name`, e.g.
 * `2026-09-24--001--first-migration`. The name is optional.
 */
const MIGRATION_NAME =
  /^(\d{4})-(\d{2})-(\d{2})--(\d{3})(?:--([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

/** For error messages. */
export const MIGRATION_NAME_FORMAT = "YYYY-MM-DD--NNN[--name]";

/** Script extensions a migrations folder is read for. */
export const MIGRATION_EXTENSIONS = /\.(ts|mts|js|mjs)$/;

export type ParsedMigrationName = {
  /**
   * `YYYY-MM-DD--NNN`: what's recorded once applied, so renaming the name
   * part doesn't run it again.
   */
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** The `NNN` part: the order within the day. */
  number: number;
  name?: string;
};

/** Splits a migration's file name, or returns `null` if it isn't one. */
export const parseMigrationName = (
  fileName: string,
): ParsedMigrationName | null => {
  const match = MIGRATION_NAME.exec(fileName.replace(MIGRATION_EXTENSIONS, ""));
  if (!match) return null;
  const [, year, month, day, number, name] = match;
  // Reject impossible dates, e.g. 2026-02-30.
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  if (
    date.getUTCFullYear() !== +year ||
    date.getUTCMonth() !== +month - 1 ||
    date.getUTCDate() !== +day
  ) {
    return null;
  }
  return {
    id: `${year}-${month}-${day}--${number}`,
    date: `${year}-${month}-${day}`,
    number: +number,
    ...(name ? { name } : {}),
  };
};

/** `"First migration!"` → `"first-migration"`. */
const slug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const pad = (n: number, length = 2) => String(n).padStart(length, "0");

/**
 * The next migration file name (without extension): today's (local) date,
 * `number` or the next one for that date among `existing` file names, and
 * `name` as a slug, if any.
 *
 * @example
 * ```ts
 * nextMigrationName([], "First migration"); // "2026-09-24--001--first-migration"
 * nextMigrationName(["2026-09-24--001--first-migration.ts"]); // "2026-09-24--002"
 * ```
 */
export const nextMigrationName = (
  existing: Iterable<string>,
  name?: string,
  now: Date = new Date(),
  number?: number,
): string => {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (number === undefined) {
    number = 1;
    for (const file of existing) {
      const parsed = parseMigrationName(file);
      if (parsed?.date === date) number = Math.max(number, parsed.number + 1);
    }
  }
  if (!Number.isInteger(number) || number < 1 || number > 999) {
    throw new Error(`${date}: migration number must be 1 to 999`);
  }
  const suffix = name ? slug(name) : "";
  const base = `${date}--${pad(number, 3)}`;
  return suffix ? `${base}--${suffix}` : base;
};

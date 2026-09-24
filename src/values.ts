import type { ParsedTable } from "./registry.ts";
import {
  type CompiledField,
  type CompiledObject,
  isPlainObject,
} from "./schema.ts";

type Row = Record<string, unknown>;

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
};

/** `where` semantics: nested plain objects match partially, the rest by value. */
export const matchesWhere = (value: unknown, where: unknown): boolean => {
  if (isPlainObject(where)) {
    return isPlainObject(value) &&
      Object.entries(where).every(([key, expected]) =>
        expected === undefined || matchesWhere(value[key], expected)
      );
  }
  return deepEqual(value, where);
};

/** Applies `fn` to each item under `[]` / `{}` modifiers (outermost last). */
const mapItems = async (
  value: unknown,
  modifiers: ("[]" | "{}")[],
  fn: (item: unknown) => unknown,
): Promise<unknown> => {
  if (!modifiers.length) return await fn(value);
  const inner = modifiers.slice(0, -1);
  const outer = modifiers[modifiers.length - 1];
  if (outer === "[]" && Array.isArray(value)) {
    return await Promise.all(value.map((item) => mapItems(item, inner, fn)));
  }
  if (outer === "{}" && isPlainObject(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async (
        [key, item],
      ) => [key, await mapItems(item, inner, fn)]),
    );
    return Object.fromEntries(entries);
  }
  return value;
};

const isEmpty = (value: unknown) => value === undefined || value === null;

/**
 * Plain row → stored row: runs each transformed field through `save`.
 * Fields in `keep` are already stored values and are left as they are.
 */
export const saveRow = async (
  table: ParsedTable,
  row: Row,
  keep: Set<string> = new Set(),
): Promise<Row> => {
  if (!table.transformed.length) return row;
  const stored = { ...row };
  for (const { field, modifiers, transform } of table.transformed) {
    if (keep.has(field) || isEmpty(stored[field])) continue;
    stored[field] = await mapItems(stored[field], modifiers, transform.save);
  }
  return stored;
};

/** Stored row → returned row: runs each field with a `load` through it. */
export const loadRow = async (table: ParsedTable, row: Row): Promise<Row> => {
  if (!table.transformed.some((t) => t.transform.load)) return row;
  const loaded = { ...row };
  for (const { field, modifiers, transform } of table.transformed) {
    if (!transform.load || isEmpty(loaded[field])) continue;
    loaded[field] = await mapItems(loaded[field], modifiers, transform.load);
  }
  return loaded;
};

/** A `where` value for a transformed field, transformed as if written. */
export const saveWhereValue = async (
  table: ParsedTable,
  field: string,
  value: unknown,
): Promise<unknown> => {
  const t = table.transformed.find((t) => t.field === field);
  if (!t || isEmpty(value)) return value;
  return await mapItems(value, t.modifiers, t.transform.save);
};

/**
 * `update` semantics: `patch` over `current`. Nested objects (plain object
 * fields) merge; arrays, maps, unions and everything else are replaced.
 * `undefined` removes a field.
 */
export const mergePatch = (
  fields: CompiledField[],
  current: Row,
  patch: Row,
): Row => {
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[key];
      continue;
    }
    const field = fields.find((f) => f.name === key);
    const nested = field && !field.modifiers.length && field.compiled.isObject
      ? (field.compiled as CompiledObject)
      : null;
    merged[key] = nested && isPlainObject(value) && isPlainObject(current[key])
      ? mergePatch(nested.fields, current[key], value)
      : value;
  }
  return merged;
};

import type {
  KrvKey,
  KrvKeyPart,
  KrvSpec,
  KrvTable,
  KrvTransform,
  KrvTransforms,
  KrvValidators,
} from "./types/main.ts";
import {
  type CompiledObject,
  type CompiledSpec,
  compileObject,
  compileSpec,
  compileValidators,
  describeValue,
  KrvSchemaError,
  parseFieldName,
} from "./schema.ts";

/** First key part reserved for krv's own bookkeeping (indexes, reference guards). */
export const INTERNAL = "__krv";

const PLACEHOLDER = /^\{([A-Za-z_$][\w$]*)\}$/;
/** `{table.placeholder}`: the table's name (literal key parts, joined by dots), then the placeholder. */
const REFERENCE = /^\{(.+)\.([A-Za-z_$][\w$]*)\}$/;

export const keyPartEquals = (a: unknown, b: unknown): boolean => {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  return a === b;
};

export const keysEqual = (a: KrvKey, b: KrvKey) =>
  a.length === b.length && a.every((part, i) => keyPartEquals(part, b[i]));

export const isKeyPart = (value: unknown): value is KrvKeyPart =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint" ||
  typeof value === "boolean" ||
  value instanceof Uint8Array;

export const keyToString = (key: KrvKey) => key.map(String).join("/");

/** Stable string id for a key, usable as a Map key. */
export const keyId = (key: KrvKey) =>
  JSON.stringify(
    key.map((part) => {
      if (part instanceof Uint8Array) return ["u8", Array.from(part)];
      if (typeof part === "bigint" || typeof part === "symbol") {
        return [typeof part, String(part)];
      }
      return [typeof part, part];
    }),
  );

/** `[__krv, "index", posts, userId, ...userKey, ...postKey]` → null */
export const indexPrefix = (source: string, field: string, target: KrvKey) => [
  INTERNAL,
  "index",
  source,
  field,
  ...target,
];

export const indexKey = (
  source: string,
  field: string,
  target: KrvKey,
  row: KrvKey,
) => [...indexPrefix(source, field, target), ...row];

/**
 * Touched by every write that adds or removes a reference to a row. Deleting
 * or moving that row checks it, so a reference created meanwhile forces a retry.
 */
export const guardKey = (target: KrvKey) => [INTERNAL, "refs", ...target];

/** `[__krv, "idx", users, byName, ...values, ...userKey]` → null */
export const secondaryPrefix = (
  table: string,
  index: string,
  values: KrvKey,
) => [INTERNAL, "idx", table, index, ...values];

/** `[__krv, "uniq", users, byEmail, ...values]` → the row's key */
export const uniqueKey = (table: string, index: string, values: KrvKey) => [
  INTERNAL,
  "uniq",
  table,
  index,
  ...values,
];

/**
 * A soft delete's group, by when it's purged: `[__krv, "soft", purgeAt,
 * rootId]` → `{ root, members: [{ key, table, expireAt? }] }` (each member's
 * `expireAt` from before, for `restore`).
 */
export const softPrefix = [INTERNAL, "soft"];
export const softKey = (purgeAt: number, root: KrvKey) => [
  ...softPrefix,
  purgeAt,
  keyId(root),
];

/** `[__krv, "softOf", table, ...key]` → `{ purgeAt, root }`, per member. */
export const softOfPrefix = (table: string) => [INTERNAL, "softOf", table];
export const softOfKey = (table: string, key: KrvKey) => [
  ...softOfPrefix(table),
  ...key,
];

type Row = Record<string, unknown>;

export type KeyPattern = (
  | { literal: string }
  /** `reference`: set for `{table.placeholder}` parts, held by a reference field. */
  | { placeholder: string; reference?: string }
)[];

export type Reference = {
  field: string;
  target: string;
  placeholder: string;
  /** Target key placeholder → field of the referencing row that holds its value. */
  fields: Record<string, string>;
  /**
   * What `delete` with `cascade: "unset"` sets it to: `"undefined"` when
   * it's optional, `"null"` when it can only be null. Unset when required.
   */
  unset?: "undefined" | "null";
};

export type TransformedField = {
  field: string;
  char: string;
  modifiers: ("[]" | "{}")[];
  transform: KrvTransform;
};

export type ParsedIndex = {
  name: string;
  fields: string[];
  unique: boolean;
  /** Field → transform applied to its plain value before indexing. */
  using: Record<string, KrvTransform>;
};

export type ParsedTable = {
  name: string;
  table: KrvTable;
  /** Validates a full row (plain values). */
  schema: CompiledObject;
  timestamps: boolean;
  transformed: TransformedField[];
  /** Fields whose stored value can't be turned back into the plain one. */
  opaque: Set<string>;
  indexes: ParsedIndex[];
  pattern: KeyPattern;
  literals: string[];
  /** Key placeholder → field holding its value. */
  bindings: Record<string, string>;
  /** Fields filled with a new ULID when left empty. */
  generated: string[];
  references: Reference[];
  incoming: { source: ParsedTable; reference: Reference }[];
};

const parsePattern = (name: string, key: readonly string[]): KeyPattern => {
  if (key.length === 0) {
    throw new KrvSchemaError(`Table "${name}": key must not be empty`);
  }
  if (key[0] === INTERNAL) {
    throw new KrvSchemaError(
      `Table "${name}": "${INTERNAL}" is a reserved key prefix`,
    );
  }

  const seen = new Set<string>();
  return key.map((part) => {
    const own = PLACEHOLDER.exec(part);
    const foreign = own ? null : REFERENCE.exec(part);
    if (!own && !foreign) {
      if (part.startsWith("{")) {
        throw new KrvSchemaError(
          `Table "${name}": invalid key placeholder "${part}"`,
        );
      }
      return { literal: part };
    }
    const placeholder = own ? own[1] : foreign![2];
    if (seen.has(placeholder)) {
      throw new KrvSchemaError(
        `Table "${name}": duplicate key placeholder {${placeholder}}`,
      );
    }
    seen.add(placeholder);
    return foreign ? { placeholder, reference: foreign[1] } : { placeholder };
  });
};

/** Two patterns overlap when some key could match both. */
const overlaps = (a: KeyPattern, b: KeyPattern) =>
  a.length === b.length &&
  a.every(
    (part, i) =>
      !("literal" in part) ||
      !("literal" in b[i]) ||
      part.literal === (b[i] as { literal: string }).literal,
  );

const TRANSFORM_CHAR = /^[^\w$?[\]{}\s]$/u;
const TIMESTAMPS = ["createdAt", "updatedAt"];
/** Fields every table gets: when the row expires, and when it was soft-deleted. */
export const EXPIRE_AT = "expireAt";
export const DELETED_AT = "deletedAt";

export const createRegistry = (
  tables: readonly KrvTable[],
  validatorDefinitions?: KrvValidators,
  transforms: KrvTransforms = {},
) => {
  // Validators first: table schemas are checked against them.
  const validators = compileValidators(validatorDefinitions);

  for (const [char, transform] of Object.entries(transforms)) {
    if (!TRANSFORM_CHAR.test(char)) {
      throw new KrvSchemaError(
        `transforms["${char}"]: must be a single character that can't be part of a field name ` +
          `(not a letter, digit, _, $, ?, [, ], {, } or whitespace)`,
      );
    }
    if (typeof transform?.save !== "function") {
      throw new KrvSchemaError(
        `transforms["${char}"]: "save" must be a function`,
      );
    }
  }
  const transformChars = new Set(Object.keys(transforms));
  const parsed = new Map<string, ParsedTable>();
  // Placeholder name referenced by each field, own or foreign.
  const fieldPlaceholders = new Map<string, Map<string, string>>();
  const pendingReferences: [
    string,
    string,
    string,
    string,
    Reference["unset"],
  ][] = [];

  for (const table of tables) {
    const pattern = parsePattern(table.key.join("/"), table.key);
    // A table is named by its literal key parts: ["posts", "{id}"] → "posts".
    const name = pattern
      .flatMap((p) => ("literal" in p ? [p.literal] : []))
      .join(".");
    if (!name) {
      throw new KrvSchemaError(
        `Table ${table.key.join("/")}: the key needs at least one literal part`,
      );
    }
    if (parsed.has(name)) {
      throw new KrvSchemaError(
        `Two tables are named "${name}": their keys have the same literal ` +
          `parts, so insert, list and references can't tell them apart`,
      );
    }
    const byPlaceholder = new Map<string, string>();
    /** Reference field → the table it references. */
    const referenced = new Map<string, string>();
    const generated: string[] = [];
    const bindings: Record<string, string> = {};
    /** Reference fields that may be empty, so they can't hold a key part. */
    const emptyable = new Set<string>();
    const timestamps = table.timestamps !== false;

    const shape: Record<string, KrvSpec> = { ...table.schema };
    for (const raw of Object.keys(table.schema)) {
      const field = parseFieldName(raw, name).name;
      if (field === EXPIRE_AT || field === DELETED_AT) {
        throw new KrvSchemaError(
          `${name}.${field}: added automatically; use another name`,
        );
      }
    }
    shape[`${EXPIRE_AT}?`] = "number";
    shape[`${DELETED_AT}?`] = "number";
    if (timestamps) {
      for (const raw of Object.keys(table.schema)) {
        const field = parseFieldName(raw, name).name;
        if (TIMESTAMPS.includes(field)) {
          throw new KrvSchemaError(
            `${name}.${field}: added automatically; remove it or set timestamps: false`,
          );
        }
      }
      shape.createdAt = "number";
      shape.updatedAt = "number";
    }

    const isRef = (spec: unknown): spec is string =>
      typeof spec === "string" && spec.startsWith("{");

    // Key fields and references live at the top level only.
    const schema = compileObject(shape, validators, name, {
      transforms: transformChars,
      topLevel: (
        { name: field, modifiers, transform, optional },
        spec,
      ): CompiledSpec | undefined => {
        if (spec === "id" && modifiers.length === 0 && !transform) {
          generated.push(field);
        }

        // A reference that may be null: ["{users.userId}", null]
        let ref: string | undefined;
        let empty: KrvSpec[] = [];
        if (isRef(spec)) ref = spec;
        else if (Array.isArray(spec) && spec.some(isRef)) {
          const refs = spec.filter(isRef);
          empty = spec.filter((option) => !isRef(option));
          if (
            refs.length !== 1 ||
            empty.some((option) => option !== null && option !== undefined)
          ) {
            throw new KrvSchemaError(
              `${name}.${field}: a reference can only be combined with null or undefined`,
            );
          }
          ref = refs[0];
        }
        if (ref === undefined) return;

        if (modifiers.length || transform) {
          throw new KrvSchemaError(
            `${name}.${field}: key fields and references can't be arrays, maps or transformed`,
          );
        }
        const own = PLACEHOLDER.exec(ref);
        const foreign = REFERENCE.exec(ref);
        if (own) {
          if (optional || empty.length) {
            throw new KrvSchemaError(
              `${name}.${field}: a key field can't be optional or null`,
            );
          }
          const part = pattern.find(
            (p) => "placeholder" in p && p.placeholder === own[1],
          ) as { placeholder: string; reference?: string } | undefined;
          if (part?.reference) {
            throw new KrvSchemaError(
              `${name}.${field}: key part {${part.reference}.${own[1]}} is a reference, ` +
                `so its field must be "{${part.reference}.${own[1]}}"`,
            );
          }
          if (!part) {
            throw new KrvSchemaError(
              `${name}.${field}: "${ref}" is not a placeholder of key ${table.key.join(
                "/",
              )}`,
            );
          }
          bindings[own[1]] = field;
          generated.push(field);
          byPlaceholder.set(field, own[1]);
        } else if (foreign) {
          pendingReferences.push([
            name,
            field,
            foreign[1],
            foreign[2],
            optional || empty.includes(undefined)
              ? "undefined"
              : empty.includes(null)
                ? "null"
                : undefined,
          ]);
          byPlaceholder.set(field, foreign[2]);
          referenced.set(field, foreign[1]);
          if (optional || empty.length) emptyable.add(field);
        } else {
          throw new KrvSchemaError(
            `${name}.${field}: "${ref}" must be "{placeholder}" or "{table.placeholder}"`,
          );
        }

        const string = compileSpec("string", validators, `${name}.${field}`);
        if (!empty.length) return string;
        const allowsNull = empty.includes(null);
        const allowsUndefined = empty.includes(undefined);
        return {
          check: (value, path) =>
            (value === null && allowsNull) ||
            (value === undefined && allowsUndefined)
              ? []
              : string.check(value, path),
          label: ["string", ...empty.map(describeValue)].join(" | "),
          allowsUndefined,
        };
      },
    });

    const transformed: TransformedField[] = schema.fields.flatMap((f) =>
      f.transform
        ? [
            {
              field: f.name,
              char: f.transform,
              modifiers: f.modifiers,
              transform: transforms[f.transform],
            },
          ]
        : [],
    );
    const opaque = new Set(
      transformed.filter((t) => !t.transform.load).map((t) => t.field),
    );

    const indexes: ParsedIndex[] = Object.entries(table.indexes ?? {}).map(
      ([index, { fields, unique, using }]) => {
        const where = `${name}.indexes.${index}`;
        if (!fields?.length) {
          throw new KrvSchemaError(`${where}: needs at least one field`);
        }

        // `using: "#"` applies to every field; `{ phone: "#" }` per field.
        const usingChars: Record<string, string> =
          typeof using === "string"
            ? Object.fromEntries(fields.map((field) => [field, using]))
            : { ...(using ?? {}) };
        for (const field of Object.keys(usingChars)) {
          if (!fields.includes(field)) {
            throw new KrvSchemaError(
              `${where}: using "${field}", which isn't one of its fields`,
            );
          }
        }

        const usingTransforms: Record<string, KrvTransform> = {};
        for (const field of fields) {
          const compiled = schema.fields.find((f) => f.name === field);
          if (!compiled) {
            throw new KrvSchemaError(`${where}: unknown field "${field}"`);
          }
          if (compiled.modifiers.length) {
            throw new KrvSchemaError(
              `${where}: "${field}" is an array or map and can't be indexed`,
            );
          }

          const own = transformed.find((t) => t.field === field);
          const char = usingChars[field];
          if (char === undefined) {
            if (own && !own.transform.deterministic) {
              throw new KrvSchemaError(
                `${where}: "${field}" uses transform "${own.char}", which isn't ` +
                  `deterministic, so it can't be indexed as stored. Index it ` +
                  `with a deterministic one: using: { ${field}: "#" }`,
              );
            }
            continue;
          }

          const transform = transforms[char];
          if (!transform) {
            throw new KrvSchemaError(
              `${where}: unknown transform "${char}" in using`,
            );
          }
          if (!transform.deterministic) {
            throw new KrvSchemaError(
              `${where}: using "${char}" on "${field}" needs a deterministic transform`,
            );
          }
          // Already stored with this transform: indexed as stored.
          if (own?.char === char) continue;
          if (own && !own.transform.load) {
            throw new KrvSchemaError(
              `${where}: "${field}" is stored with "${own.char}", which has no ` +
                `load, so its plain value can't be indexed through "${char}"`,
            );
          }
          usingTransforms[field] = transform;
        }

        return {
          name: index,
          fields: [...fields],
          unique: unique ?? false,
          using: usingTransforms,
        };
      },
    );

    const entry: ParsedTable = {
      name,
      table,
      schema,
      timestamps,
      transformed,
      opaque,
      indexes,
      pattern,
      literals: pattern.flatMap((p) => ("literal" in p ? [p.literal] : [])),
      bindings,
      generated,
      references: [],
      incoming: [],
    };

    // A key placeholder not held by an own field may come from a reference
    // with the same placeholder name, e.g. `orgId: "{orgs.orgId}"`.
    // A `{table.placeholder}` key part is held by the field referencing
    // exactly that, e.g. `accountId: "{accounts.accountId}"`.
    for (const part of pattern) {
      if (!("placeholder" in part)) continue;
      const { placeholder, reference } = part;
      if (entry.bindings[placeholder]) continue;
      const field = [...byPlaceholder].find(
        ([f, p]) =>
          p === placeholder &&
          (reference === undefined || referenced.get(f) === reference),
      )?.[0];
      if (!field) {
        throw new KrvSchemaError(
          reference === undefined
            ? `Table "${name}": key placeholder {${placeholder}} has no schema field`
            : `Table "${name}": key part {${reference}.${placeholder}} needs a ` +
                `field "{${reference}.${placeholder}}" in the schema`,
        );
      }
      if (emptyable.has(field)) {
        throw new KrvSchemaError(
          `${name}.${field}: holds key placeholder {${placeholder}}, so it can't be optional or null`,
        );
      }
      entry.bindings[placeholder] = field;
    }

    parsed.set(name, entry);
    fieldPlaceholders.set(name, byPlaceholder);
  }

  for (const [
    sourceName,
    field,
    targetName,
    placeholder,
    unset,
  ] of pendingReferences) {
    const source = parsed.get(sourceName)!;
    const target = parsed.get(targetName);
    if (!target) {
      throw new KrvSchemaError(
        `${source.name}.${field}: referenced table "${targetName}" does not exist`,
      );
    }
    if (!(placeholder in target.bindings)) {
      throw new KrvSchemaError(
        `${source.name}.${field}: {${placeholder}} is not a key placeholder of "${targetName}"`,
      );
    }

    // Every other placeholder of the target key must be available in this row.
    const fields: Record<string, string> = { [placeholder]: field };
    for (const other of Object.keys(target.bindings)) {
      if (other === placeholder) continue;
      const holder = [...fieldPlaceholders.get(source.name)!].find(
        ([, p]) => p === other,
      )?.[0];
      if (!holder) {
        throw new KrvSchemaError(
          `${source.name}.${field}: referencing "${targetName}" also needs a field for {${other}}`,
        );
      }
      fields[other] = holder;
    }

    const reference: Reference = {
      field,
      target: targetName,
      placeholder,
      fields,
      ...(unset && { unset }),
    };
    source.references.push(reference);
    target.incoming.push({ source, reference });
  }

  const all = [...parsed.values()];
  for (const a of all) {
    for (const b of all) {
      if (a === b) continue;
      if (overlaps(a.pattern, b.pattern)) {
        throw new KrvSchemaError(
          `Tables "${a.name}" and "${b.name}" have overlapping keys: ` +
            `${a.table.key.join("/")} and ${b.table.key.join("/")}`,
        );
      }
    }
  }

  const matches = (table: ParsedTable, key: KrvKey) =>
    key.length === table.pattern.length &&
    table.pattern.every((part, i) =>
      "literal" in part
        ? keyPartEquals(part.literal, key[i])
        : isKeyPart(key[i]),
    );

  /** Finds the table a full row key belongs to. */
  const resolveKey = (key: KrvKey): ParsedTable => {
    const table = all.find((t) => matches(t, key));
    if (!table) throw new Error(`No table for key ${keyToString(key)}`);
    return table;
  };

  /** Finds the table by the literal parts of its key, e.g. `["posts"]`. */
  const resolveLiterals = (literals: KrvKey): ParsedTable => {
    const table = all.find((t) => keysEqual(t.literals, literals));
    if (!table) throw new Error(`No table with key ${keyToString(literals)}`);
    return table;
  };

  /** Builds a row's key from its fields. */
  const rowKey = (table: ParsedTable, row: Row): KrvKey =>
    table.pattern.map((part) => {
      if ("literal" in part) return part.literal;
      const field = table.bindings[part.placeholder];
      const value = row[field];
      if (!isKeyPart(value)) {
        throw new Error(`${table.name}.${field}: missing key value`);
      }
      return value;
    });

  /** Key of the row `reference` points at, or null when the field is empty. */
  const targetKey = (reference: Reference, row: Row): KrvKey | null => {
    const target = parsed.get(reference.target)!;
    const key: KrvKeyPart[] = [];
    for (const part of target.pattern) {
      if ("literal" in part) {
        key.push(part.literal);
        continue;
      }
      const value = row[reference.fields[part.placeholder]];
      if (!isKeyPart(value)) return null;
      key.push(value);
    }
    return key;
  };

  /**
   * An index's values for a stored row, or null when any of them is empty.
   * Fields indexed `using` a transform are loaded to their plain value first.
   */
  const indexValues = async (
    table: ParsedTable,
    index: ParsedIndex,
    row: Row,
  ): Promise<KrvKeyPart[] | null> => {
    const values: KrvKeyPart[] = [];
    for (const field of index.fields) {
      let value = row[field];
      const using = index.using[field];
      if (using && value !== undefined && value !== null) {
        const own = table.transformed.find((t) => t.field === field);
        if (own?.transform.load) value = await own.transform.load(value);
        value = await using.save(value);
      }
      if (!isKeyPart(value)) return null;
      values.push(value);
    }
    return values;
  };

  /**
   * An index's values for a `where`: fields indexed `using` a transform take
   * the plain value, the others the stored one. Null if not all are given.
   */
  const whereIndexValues = async (
    index: ParsedIndex,
    stored: Row,
    plain: Row,
  ): Promise<KrvKeyPart[] | null> => {
    const values: KrvKeyPart[] = [];
    for (const field of index.fields) {
      const using = index.using[field];
      const value = using
        ? plain[field] === undefined
          ? undefined
          : await using.save(plain[field])
        : stored[field];
      if (!isKeyPart(value)) return null;
      values.push(value);
    }
    return values;
  };

  /** Fields `where` can match through an index `using` a transform. */
  const searchableByIndex = (table: ParsedTable, field: string) =>
    table.indexes.some((index) => index.using[field]);

  return {
    resolveKey,
    resolveLiterals,
    rowKey,
    targetKey,
    indexValues,
    whereIndexValues,
    searchableByIndex,
    matches,
    tables: all,
    transforms,
    get: (name: string) => parsed.get(name)!,
    byName: (name: string) => parsed.get(name),
  };
};

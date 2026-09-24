import type {
  KrvIndex,
  KrvSchemaDef,
  KrvSpec,
  KrvTable,
  KrvValidatorArg,
  KrvValidators,
} from "./types/main.ts";

/**
 * Declares a table. Its schema is checked by `openKRV`, against its validators.
 *
 * @param definition
 *   - `key`: literal parts and `{placeholder}` parts, e.g. `["users", "{userId}"]`.
 *     Without placeholders the table is static: one value at exactly that key.
 *   - `schema`: the row's fields. See the README for the full syntax.
 *
 * @example
 * ```ts
 * table({
 *   key: ["posts", "{postId}"],
 *   schema: {
 *     id: "{postId}",
 *     authorId: "{users.userId}",
 *     title: "string",
 *     "tags[]": "string",
 *     status: ["|draft|", "|published|"],
 *   },
 * });
 * ```
 */
export const table = <
  const Key extends readonly string[],
  const Schema extends KrvSchemaDef,
  const Timestamps extends boolean = true,
  const Indexes extends Record<string, KrvIndex> = Record<never, never>,
>(definition: {
  key: Key;
  schema: Schema;
  /** Automatic `createdAt` / `updatedAt` fields. Default `true`. */
  timestamps?: Timestamps;
  /** Secondary indexes over top-level fields, by name. */
  indexes?: Indexes;
}): NoInfer<KrvTable<Key, Schema, Timestamps, Indexes>> => definition;

// ---- Runtime schema compiler ----

export type Check = (value: unknown, path: string) => string[];

export type CompiledSpec = {
  check: Check;
  /** Human-readable type, used in error messages. */
  label: string;
  /** Whether `undefined` passes, making the field optional. */
  allowsUndefined: boolean;
  /** Set for nested objects. */
  isObject?: boolean;
};

export type CompiledField = {
  /** Field name without modifiers. */
  name: string;
  spec: KrvSpec;
  /** `[]` and `{}` modifiers, left to right. */
  modifiers: ("[]" | "{}")[];
  /** Transform character, top-level fields only. */
  transform?: string;
  optional: boolean;
  compiled: CompiledSpec;
};

export type CompiledObject = CompiledSpec & {
  fields: CompiledField[];
  /** Like `check`, but fields in `skip` are only checked for presence. */
  checkExcept: (value: unknown, path: string, skip: Set<string>) => string[];
};

type CompiledValidator = {
  name: string;
  params: string[];
  base: CompiledSpec;
  fn: (value: unknown, args: Record<string, KrvValidatorArg>) => boolean;
};

export type ValidatorRegistry = Map<string, CompiledValidator>;

const BUILTINS: Record<string, (value: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && !Number.isNaN(v),
  boolean: (v) => typeof v === "boolean",
  bigint: (v) => typeof v === "bigint",
  date: (v) => v instanceof Date && !Number.isNaN(v.getTime()),
  unknown: () => true,
  id: (v) => typeof v === "string",
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** name, `[]`/`{}` modifiers, a transform character, `?`. */
const FIELD_NAME =
  /^([A-Za-z_$][\w$]*)((?:\[\]|\{\})*)([^\w$?[\]{}\s])?(\?)?$/u;
const CALL = /^([A-Za-z_$][\w$]*)(?:\((.*)\))?$/;
const STRING_LITERAL = /^\|(.*)\|$/s;
const KEY_REF = /^\{.*\}$/;

/** A table definition or validator is invalid. Thrown by `openKRV`. */
export class KrvSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KrvSchemaError";
  }
}

export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const describeValue = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  return typeof value;
};

const mismatch =
  (label: string): Check =>
  (value, path) => [`${path}: expected ${label}, got ${describeValue(value)}`];

const literal = (expected: unknown, label: string): CompiledSpec => ({
  check: (value, path) =>
    value === expected ? [] : mismatch(label)(value, path),
  label,
  allowsUndefined: expected === undefined,
});

/** Parses a validator argument: `3`, `|text|`, `true`, `false`, `null`. */
const parseArg = (raw: string, where: string): KrvValidatorArg => {
  const text = raw.trim();
  const string = STRING_LITERAL.exec(text);
  if (string) return string[1];
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (text !== "" && !Number.isNaN(Number(text))) return Number(text);
  throw new KrvSchemaError(
    `${where}: invalid argument "${text}" (use a number, |text|, true, false or null)`,
  );
};

const compileString = (
  spec: string,
  validators: ValidatorRegistry,
  where: string,
): CompiledSpec => {
  const builtin = BUILTINS[spec];
  if (builtin) {
    return {
      check: (v, path) => (builtin(v) ? [] : mismatch(spec)(v, path)),
      label: spec,
      allowsUndefined: spec === "unknown",
    };
  }

  const text = STRING_LITERAL.exec(spec);
  if (text) return literal(text[1], JSON.stringify(text[1]));

  if (KEY_REF.test(spec)) {
    throw new KrvSchemaError(
      `${where}: "${spec}" is only allowed as a plain top-level field of a table`,
    );
  }

  const call = CALL.exec(spec);
  const validator = call && validators.get(call[1]);
  if (!call || !validator) {
    throw new KrvSchemaError(`${where}: unknown type "${spec}"`);
  }

  const rawArgs =
    call[2] === undefined || call[2].trim() === "" ? [] : call[2].split(",");
  if (rawArgs.length !== validator.params.length) {
    throw new KrvSchemaError(
      `${where}: "${validator.name}" takes ${validator.params.length} argument(s) ` +
        `(${validator.params.join(", ")}), got ${rawArgs.length}`,
    );
  }
  const args = Object.fromEntries(
    validator.params.map((param, i) => [param, parseArg(rawArgs[i], where)]),
  );

  return {
    check: (value, path) => {
      const issues = validator.base.check(value, path);
      if (issues.length) return issues;
      return validator.fn(value, args)
        ? []
        : [`${path}: ${describeValue(value)} is not a valid ${spec}`];
    },
    label: spec,
    allowsUndefined: validator.base.allowsUndefined,
  };
};

const compileUnion = (
  options: readonly KrvSpec[],
  validators: ValidatorRegistry,
  where: string,
): CompiledSpec => {
  if (options.length === 0) {
    throw new KrvSchemaError(`${where}: a union needs at least one option`);
  }
  const compiled = options.map((option) =>
    compileSpec(option, validators, where),
  );
  const label = compiled.map((c) => c.label).join(" | ");

  return {
    check: (value, path) => {
      if (compiled.some((c) => c.check(value, path).length === 0)) return [];
      // A single object option: report its detailed issues.
      const objects = compiled.filter((c) => c.isObject);
      if (objects.length === 1 && isPlainObject(value)) {
        return objects[0].check(value, path);
      }
      return mismatch(label)(value, path);
    },
    label,
    allowsUndefined: compiled.some((c) => c.allowsUndefined),
  };
};

/** Wraps a field's spec with its `[]` / `{}` modifiers (applied left to right). */
const wrap = (inner: CompiledSpec, modifiers: ("[]" | "{}")[]): CompiledSpec =>
  modifiers.reduce<CompiledSpec>((spec, modifier) => {
    if (modifier === "[]") {
      return {
        check: (value, path) =>
          Array.isArray(value)
            ? value.flatMap((item, i) => spec.check(item, `${path}[${i}]`))
            : mismatch(`${spec.label}[]`)(value, path),
        label: `${spec.label}[]`,
        allowsUndefined: false,
      };
    }
    return {
      check: (value, path) =>
        isPlainObject(value)
          ? Object.entries(value).flatMap(([key, item]) =>
              spec.check(item, `${path}.${key}`),
            )
          : mismatch(`${spec.label}{}`)(value, path),
      label: `${spec.label}{}`,
      allowsUndefined: false,
    };
  }, inner);

/** Parses `"tags[]&?"` into its name, modifiers, transform and `?`. */
export const parseFieldName = (raw: string, where: string) => {
  const match = FIELD_NAME.exec(raw);
  if (!match) {
    throw new KrvSchemaError(
      `${where}: invalid field name "${raw}" (use name, then [] / {} modifiers, ` +
        `then an optional transform character, then an optional ?)`,
    );
  }
  return {
    name: match[1],
    modifiers: (match[2].match(/\[\]|\{\}/g) ?? []) as ("[]" | "{}")[],
    transform: match[3] as string | undefined,
    optional: match[4] === "?",
  };
};

export type ParsedFieldName = ReturnType<typeof parseFieldName>;

export const compileObject = (
  shape: Record<string, KrvSpec>,
  validators: ValidatorRegistry,
  where: string,
  table?: {
    /** Declared transform characters. */
    transforms: Set<string>;
    /** Handles specs allowed only at a table's top level (key fields, references). */
    topLevel: (
      field: ParsedFieldName,
      spec: KrvSpec,
    ) => CompiledSpec | undefined;
  },
): CompiledObject => {
  const fields: CompiledField[] = [];
  const names = new Set<string>();

  for (const [raw, spec] of Object.entries(shape)) {
    const parsed = parseFieldName(raw, where);
    const { name, modifiers, transform, optional } = parsed;
    if (names.has(name)) {
      throw new KrvSchemaError(`${where}: field "${name}" is declared twice`);
    }
    names.add(name);

    if (transform !== undefined) {
      if (!table) {
        throw new KrvSchemaError(
          `${where}.${name}: transforms ("${transform}") are only allowed on a table's top-level fields`,
        );
      }
      if (!table.transforms.has(transform)) {
        throw new KrvSchemaError(
          `${where}.${name}: unknown transform "${transform}"`,
        );
      }
    }

    const inner =
      table?.topLevel(parsed, spec) ??
      compileSpec(spec, validators, `${where}.${name}`);
    const compiled = wrap(inner, modifiers);
    fields.push({
      name,
      spec,
      modifiers,
      transform,
      optional: optional || compiled.allowsUndefined,
      compiled,
    });
  }

  const checkExcept = (value: unknown, path: string, skip: Set<string>) => {
    if (!isPlainObject(value)) return mismatch("object")(value, path);

    const issues: string[] = [];
    for (const key of Object.keys(value)) {
      if (!names.has(key)) issues.push(`${path}.${key}: unknown field`);
    }
    for (const field of fields) {
      const item = value[field.name];
      if (item === undefined) {
        if (!field.optional) issues.push(`${path}.${field.name}: required`);
        continue;
      }
      if (skip.has(field.name)) continue;
      issues.push(...field.compiled.check(item, `${path}.${field.name}`));
    }
    return issues;
  };
  const none = new Set<string>();
  const check: Check = (value, path) => checkExcept(value, path, none);

  const label = `{ ${fields
    .map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.compiled.label}`)
    .join(", ")} }`;
  return {
    check,
    checkExcept,
    label,
    allowsUndefined: false,
    isObject: true,
    fields,
  };
};

export const compileSpec = (
  spec: KrvSpec,
  validators: ValidatorRegistry,
  where: string,
): CompiledSpec => {
  if (typeof spec === "string") return compileString(spec, validators, where);
  if (Array.isArray(spec)) return compileUnion(spec, validators, where);
  if (isPlainObject(spec)) {
    return compileObject(spec as Record<string, KrvSpec>, validators, where);
  }
  if (
    spec === null ||
    spec === undefined ||
    typeof spec === "number" ||
    typeof spec === "boolean"
  ) {
    return literal(spec, describeValue(spec));
  }
  throw new KrvSchemaError(`${where}: invalid type ${describeValue(spec)}`);
};

/** Compiles `openKRV`'s `validators`. Their bases can't use other validators. */
export const compileValidators = (
  definitions: KrvValidators = {},
): ValidatorRegistry => {
  const registry: ValidatorRegistry = new Map();

  for (const [declaration, definition] of Object.entries(definitions)) {
    const where = `validators["${declaration}"]`;
    const call = CALL.exec(declaration);
    if (!call) {
      throw new KrvSchemaError(
        `${where}: must be "name" or "name(param, ...)"`,
      );
    }
    const [, name, rawParams] = call;
    if (BUILTINS[name]) {
      throw new KrvSchemaError(`${where}: "${name}" is a built-in type`);
    }
    if (registry.has(name)) {
      throw new KrvSchemaError(`${where}: "${name}" is declared twice`);
    }

    const params =
      rawParams === undefined || rawParams.trim() === ""
        ? []
        : rawParams.split(",").map((p) => p.trim());
    for (const param of params) {
      if (!IDENTIFIER.test(param)) {
        throw new KrvSchemaError(`${where}: invalid parameter "${param}"`);
      }
    }

    if (!Array.isArray(definition) || typeof definition[1] !== "function") {
      throw new KrvSchemaError(
        `${where}: must be [baseType, (value) => boolean]`,
      );
    }

    registry.set(name, {
      name,
      params,
      base: compileSpec(definition[0], new Map(), `${where} base`),
      fn: definition[1] as CompiledValidator["fn"],
    });
  }

  return registry;
};

import { assertEquals, assertRejects } from "@std/assert";
import {
  KrvSchemaError,
  KrvValidationError,
  openKRV,
  table,
} from "../src/main.ts";

/** Same validators as `open`, for tests that build invalid tables. */
const validators = {
  email: ["string", (v: string) => v.includes("@")],
  "str(min, max)": [
    "string",
    (s: string, { min, max }: { min: number; max: number }) =>
      s.length >= min && s.length <= max,
  ],
} as const;

const open = () =>
  openKRV({
    path: ":memory:",
    validators: {
      email: ["string", (v) => v.includes("@")],
      positive: ["number", (n) => n > 0],
      "str(min, max)": [
        "string",
        (s, { min, max }: { min: number; max: number }) =>
          s.length >= min && s.length <= max,
      ],
      "oneOf(a, b)": [
        "string",
        (s, { a, b }: { a: string; b: string }) => s === a || s === b,
      ],
    },
    tables: [
      table({
        key: ["items", "{itemId}"],
        schema: {
          id: "{itemId}",
          text: "string",
          count: "number",
          flag: "boolean",
          big: "bigint",
          at: "date",
          any: "unknown",
          token: "id",
          status: ["|draft|", "|published|"],
          level: [1, 2, 3],
          ref: ["string", "number"],
          maybe: ["string", null],
          "note?": "string",
          views: ["number", undefined],
          "tags[]": "string",
          "labels[]?": "string",
          "scores{}": "number",
          "groups{}[]": "string",
          "matrix[][]": "number",
          meta: { source: "string", "score?": "positive" },
          "files[]": { url: "string", size: "number" },
          shape: [
            { type: "|circle|", r: "number" },
            { type: "|rect|", w: "number", h: "number" },
          ],
          mail: "email",
          name: "str(1, 10)",
          kind: "oneOf(|a|, |b|)",
          "aliases[]?": "str(1, 5)",
        },
      }),
    ],
  });

type Db = Awaited<ReturnType<typeof open>>;

const valid = () => ({
  text: "t",
  count: 1,
  flag: true,
  big: 1n,
  at: new Date(0),
  any: { anything: [1] },
  status: "draft" as const,
  level: 2 as const,
  ref: "r",
  maybe: null,
  tags: ["a"],
  scores: { a: 1 },
  groups: [{ a: "x" }],
  matrix: [[1, 2], [3]],
  meta: { source: "s" },
  files: [{ url: "u", size: 1 }],
  shape: { type: "circle" as const, r: 1 },
  mail: "a@b.c",
  name: "pagoru",
  kind: "a",
});

const issuesOf = async (db: Db, patch: Record<string, unknown>) => {
  try {
    await db.insert(["items"], { ...valid(), ...patch } as never);
    return [];
  } catch (error) {
    if (error instanceof KrvValidationError) return error.issues;
    throw error;
  }
};

Deno.test("schema: a valid row is stored with generated fields", async () => {
  await using db = Object.assign(await open(), {
    [Symbol.asyncDispose]: async () => {},
  });
  const { key, value } = await db.insert(["items"], valid());

  assertEquals(key, ["items", value.id]);
  assertEquals(value.token.length, 26);
  assertEquals((await db.get(key)).value, value);
  db.close();
});

Deno.test(
  "schema: optional fields may be left out, required ones may not",
  async () => {
    const db = await open();
    // note?, views (union with undefined), labels[]? and meta.score? are optional.
    assertEquals(await issuesOf(db, {}), []);
    assertEquals(
      await issuesOf(db, { note: "n", views: 3, labels: ["x"] }),
      [],
    );

    assertEquals(await issuesOf(db, { text: undefined }), [
      "items.text: required",
    ]);
    db.close();
  },
);

Deno.test("schema: types, literals and unions", async () => {
  const db = await open();
  const cases: [Record<string, unknown>, string][] = [
    [{ text: 1 }, "items.text: expected string, got 1"],
    [{ count: NaN }, "items.count: expected number, got NaN"],
    [{ big: 1 }, "items.big: expected bigint, got 1"],
    [{ at: "2020" }, 'items.at: expected date, got "2020"'],
    [
      { status: "blue" },
      'items.status: expected "draft" | "published", got "blue"',
    ],
    [{ level: 4 }, "items.level: expected 1 | 2 | 3, got 4"],
    [{ ref: true }, "items.ref: expected string | number, got true"],
    [{ maybe: 1 }, "items.maybe: expected string | null, got 1"],
    [{ views: "x" }, 'items.views: expected number | undefined, got "x"'],
  ];
  for (const [patch, issue] of cases) {
    assertEquals(await issuesOf(db, patch), [issue]);
  }
  db.close();
});

Deno.test("schema: field-name modifiers", async () => {
  const db = await open();
  const cases: [Record<string, unknown>, string][] = [
    [{ tags: "a" }, 'items.tags: expected string[], got "a"'],
    [{ tags: ["a", 2] }, "items.tags[1]: expected string, got 2"],
    [{ scores: [1] }, "items.scores: expected number{}, got array"],
    [{ scores: { a: "x" } }, 'items.scores.a: expected number, got "x"'],
    [{ groups: [{ a: 1 }] }, "items.groups[0].a: expected string, got 1"],
    [{ matrix: [[1], ["x"]] }, 'items.matrix[1][0]: expected number, got "x"'],
  ];
  for (const [patch, issue] of cases) {
    assertEquals(await issuesOf(db, patch), [issue]);
  }
  db.close();
});

Deno.test("schema: nested objects are strict and report paths", async () => {
  const db = await open();
  assertEquals(await issuesOf(db, { meta: { source: 1 } }), [
    "items.meta.source: expected string, got 1",
  ]);
  assertEquals(await issuesOf(db, { meta: { source: "s", extra: 1 } }), [
    "items.meta.extra: unknown field",
  ]);
  assertEquals(await issuesOf(db, { files: [{ url: "u" }] }), [
    "items.files[0].size: required",
  ]);
  assertEquals(await issuesOf(db, { extra: 1 }), [
    "items.extra: unknown field",
  ]);
  // A union of object shapes: the value must match one of them.
  assertEquals(await issuesOf(db, { shape: { type: "rect", w: 1, h: 2 } }), []);
  assertEquals(await issuesOf(db, { shape: { type: "circle", w: 1 } }), [
    'items.shape: expected { type: "circle", r: number } | { type: "rect", w: number, h: number }, got object',
  ]);
  db.close();
});

Deno.test("schema: custom validators, with and without arguments", async () => {
  const db = await open();
  const cases: [Record<string, unknown>, string][] = [
    [{ mail: "nope" }, 'items.mail: "nope" is not a valid email'],
    [{ mail: 1 }, "items.mail: expected string, got 1"],
    [{ name: "" }, 'items.name: "" is not a valid str(1, 10)'],
    [
      { name: "x".repeat(11) },
      `items.name: "${"x".repeat(11)}" is not a valid str(1, 10)`,
    ],
    [{ kind: "c" }, 'items.kind: "c" is not a valid oneOf(|a|, |b|)'],
    [
      { meta: { source: "s", score: -1 } },
      "items.meta.score: -1 is not a valid positive",
    ],
    [
      { aliases: ["ok", "toolong"] },
      'items.aliases[1]: "toolong" is not a valid str(1, 5)',
    ],
  ];
  for (const [patch, issue] of cases) {
    assertEquals(await issuesOf(db, patch), [issue]);
  }
  db.close();
});

Deno.test("schema: every issue is reported at once", async () => {
  const db = await open();
  const issues = await issuesOf(db, { text: 1, count: "x", mail: "nope" });
  assertEquals(issues.length, 3);
  db.close();
});

Deno.test(
  "schema: invalid schemas are rejected at open with KrvSchemaError",
  async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ mail: "emial" }, 'unknown type "emial"'],
      [{ s: "|draft" }, 'unknown type "|draft"'],
      [{ name: "str(3)" }, '"str" takes 2 argument(s) (min, max), got 1'],
      [{ name: "str(a, 5)" }, 'invalid argument "a"'],
      [{ "tags?[]": "string" }, 'invalid field name "tags?[]"'],
      [{ a: "string", "a?": "string" }, 'field "a" is declared twice'],
      [{ m: { u: "{x.id}" } }, "only allowed as a plain top-level field"],
      [{ "u[]": "{t.id}" }, "key fields and references can't be arrays"],
      [
        { u: ["{t.id}", "string"] },
        "can only be combined with null or undefined",
      ],
      [{ "x!": "string" }, 'unknown transform "!"'],
      [{ m: { "x!": "string" } }, "only allowed on a table's top-level fields"],
      [{ createdAt: "number" }, "added automatically"],
      [{ u: [] }, "a union needs at least one option"],
    ];

    for (const [schema, message] of cases) {
      await assertRejects(
        () =>
          openKRV({
            path: ":memory:",
            validators: validators as never,
            tables: [
              table({ key: ["t", "{id}"], schema: { id: "{id}", ...schema } }),
            ] as never,
          }),
        KrvSchemaError,
        message,
      );
    }
  },
);

Deno.test(
  "schema: invalid validator declarations are rejected at open",
  async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ string: ["string", () => true] }, '"string" is a built-in type'],
      [
        { "bad name": ["string", () => true] },
        'must be "name" or "name(param, ...)"',
      ],
      [{ "f(1x)": ["string", () => true] }, 'invalid parameter "1x"'],
      [{ f: ["string"] }, "must be [baseType, (value) => boolean]"],
      [{ f: ["nope", () => true] }, 'unknown type "nope"'],
    ];

    for (const [defs, message] of cases) {
      await assertRejects(
        () =>
          openKRV({
            path: ":memory:",
            validators: defs as never,
            tables: [],
          }),
        KrvSchemaError,
        message,
      );
    }
  },
);

Deno.test("schema: typos are compile errors", () => {
  // Only type-checked, never run.
  const compileOnly = () => {
    openKRV({
      validators: {
        email: ["string", (v) => v.includes("@")],
        "str(min, max)": [
          "string",
          (s, { min, max }: { min: number; max: number }) =>
            s.length >= min && s.length <= max,
        ],
      },
      tables: [
        // @ts-expect-error "emial" is not a type
        table({ key: ["a", "{id}"], schema: { id: "{id}", m: "emial" } }),
      ],
    });
    openKRV({
      validators: {
        "str(min, max)": [
          "string",
          (s, { min, max }: { min: number; max: number }) =>
            s.length >= min && s.length <= max,
        ],
      },
      tables: [
        // @ts-expect-error str takes two arguments
        table({ key: ["a", "{id}"], schema: { id: "{id}", n: "str(3)" } }),
      ],
    });
    openKRV({
      validators: {
        "str(min, max)": [
          "string",
          (s, { min, max }: { min: number; max: number }) =>
            s.length >= min && s.length <= max,
        ],
      },
      tables: [
        // @ts-expect-error str's arguments are numbers
        table({
          key: ["a", "{id}"],
          schema: { id: "{id}", n: "str(|x|, 3)" },
        }),
      ],
    });
    openKRV({
      tables: [
        // @ts-expect-error missing closing pipe
        table({ key: ["a", "{id}"], schema: { id: "{id}", s: "|draft" } }),
      ],
    });
    openKRV({
      // @ts-expect-error a number has no .includes
      validators: { x: ["number", (v) => v.includes("a")] },
      tables: [],
    });
  };
  void compileOnly;
});

Deno.test("schema: inferred row types", async () => {
  const db = await open();
  const { value } = await db.insert(["items"], valid());

  // Assignments both ways: the inferred type is exactly this.
  type Expected = {
    id: string;
    text: string;
    count: number;
    flag: boolean;
    big: bigint;
    at: Date;
    any?: unknown; // "unknown" accepts undefined, so the field is optional
    token: string;
    status: "draft" | "published";
    level: 1 | 2 | 3;
    ref: string | number;
    maybe: string | null;
    note?: string;
    views?: number;
    tags: string[];
    labels?: string[];
    scores: Record<string, number>;
    groups: Record<string, string>[];
    matrix: number[][];
    meta: { source: string; score?: number };
    files: { url: string; size: number }[];
    shape:
      | { type: "circle"; r: number }
      | {
          type: "rect";
          w: number;
          h: number;
        };
    mail: string;
    name: string;
    kind: string;
    aliases?: string[];
    createdAt: number;
    updatedAt: number;
  };
  const expected: Expected = value;
  const back: typeof value = expected;
  assertEquals(back, value);
  db.close();
});

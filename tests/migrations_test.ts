import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type KrvMigration,
  KrvSchemaError,
  nextMigrationName,
  openKRV,
  parseMigrationName,
  table,
} from "../src/main.ts";
import { newMigration } from "../cli.ts";
import { transforms } from "./_crypto.ts";

const tempPath = async () => `${await Deno.makeTempDir()}/db`;

const exists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

const usersV1 = [
  table({
    key: ["users", "{userId}"],
    schema: { id: "{userId}", name: "string" },
  }),
];

const usersV2 = [
  table({
    key: ["users", "{userId}"],
    schema: { id: "{userId}", name: "string", age: "number" },
  }),
];

/** A migration as if in `migrations/<fileName>.ts`. */
const migration = (
  fileName: string,
  up: KrvMigration["up"],
  extra: Partial<KrvMigration> = {},
): KrvMigration => ({
  url: `file:///app/migrations/${fileName}.ts`,
  up,
  ...extra,
});

Deno.test("migrations: run once each, by date", async () => {
  const path = await tempPath();
  const ran: string[] = [];
  const migrations = [
    migration("2026-01-02--001", () => void ran.push("b")),
    migration("2026-01-01--001", () => void ran.push("a")),
  ];

  const db = await openKRV({ path, tables: usersV1, migrations });
  db.close();
  assertEquals(ran, ["a", "b"]);

  const again = await openKRV({ path, tables: usersV1, migrations });
  again.close();
  assertEquals(ran, ["a", "b"]); // already applied
});

Deno.test(
  "migrations: ordered by date, then number, whatever the declared order",
  async () => {
    const path = await tempPath();
    const ran: string[] = [];
    const migrations = [
      migration("2026-01-02--001--c", () => void ran.push("c")),
      migration("2026-01-01--010--b", () => void ran.push("b")),
      migration("2026-01-01--002--a", () => void ran.push("a")),
    ];
    (await openKRV({ path, tables: usersV1, migrations })).close();
    assertEquals(ran, ["a", "b", "c"]);
  },
);

Deno.test(
  "migrations: only the name is stored; renaming its name part doesn't rerun it",
  async () => {
    const path = await tempPath();
    let runs = 0;
    const up = () => void runs++;
    const first = migration("2026-01-01--001--add-age", up, {
      description: "adds age",
    });
    (await openKRV({ path, tables: usersV1, migrations: [first] })).close();

    const kv = await Deno.openKv(path);
    const [stored] = await Array.fromAsync(
      kv.list({ prefix: ["__krv", "migrations"] }),
    );
    kv.close();
    assertEquals(stored.key, ["__krv", "migrations", "2026-01-01--001"]);
    const {
      appliedAt: _,
      durationMs: __,
      ...value
    } = stored.value as Record<string, unknown>;
    assertEquals(value, {
      id: "2026-01-01--001",
      fileName: "2026-01-01--001--add-age",
      description: "adds age",
    });

    const renamed = {
      ...first,
      url: "file:///elsewhere/2026-01-01--001--add-ages.ts",
    };
    (await openKRV({ path, tables: usersV1, migrations: [renamed] })).close();
    assertEquals(runs, 1);
  },
);

Deno.test("migrations: invalid names and duplicates are rejected", async () => {
  const cases: [KrvMigration[], string][] = [
    [[migration("users", () => {})], "must be YYYY-MM-DD--NNN[--name]"],
    [[migration("2026-02-30--001", () => {})], "must be YYYY-MM-DD--NNN"],
    [[migration("2026-01-01--1--x", () => {})], "must be YYYY-MM-DD--NNN"],
    [[migration("2026-01-01--001--Bad_Name", () => {})], "must be"],
    [
      [
        migration("2026-01-01--001--a", () => {}),
        migration("2026-01-01--001--b", () => {}),
      ],
      "share the number 2026-01-01--001",
    ],
    [
      [
        migration("2026-01-01--001", () => {}),
        migration("2026-01-01--001", () => {}),
      ],
      "declared twice",
    ],
    [[{ up: () => {} } as unknown as KrvMigration], "url: import.meta.url"],
  ];
  for (const [migrations, message] of cases) {
    await assertRejects(
      () => openKRV({ path: ":memory:", tables: usersV1, migrations }),
      KrvSchemaError,
      message,
    );
  }
});

Deno.test(
  "migrations: a real file names itself with import.meta.url",
  async () => {
    const dir = await Deno.makeTempDir();
    const file = await newMigration("Añadir edad!", `${dir}/migrations`);
    const name = file.slice(file.lastIndexOf("/") + 1, -".ts".length);
    assert(/^\d{4}-\d{2}-\d{2}--001--anadir-edad$/.test(name));
    assert((await Deno.readTextFile(file)).includes("url: import.meta.url"));

    const path = `${dir}/db`;
    const db = await openKRV({
      path,
      tables: usersV1,
      migrations: [import(new URL(`file://${file}`).href)],
    });
    db.close();
    const kv = await Deno.openKv(path);
    const [stored] = await Array.fromAsync(
      kv.list<{ fileName: string }>({ prefix: ["__krv", "migrations"] }),
    );
    kv.close();
    assertEquals(stored.value.fileName, name);
  },
);

Deno.test(
  "new-migration: numbers after today's files, or --number",
  async () => {
    const dir = `${await Deno.makeTempDir()}/migrations`;
    const at = (file: string) => file.slice(file.lastIndexOf("/") + 1);
    const today = nextMigrationName([]).slice(0, 10);

    assertEquals(
      at(await newMigration("first", dir)),
      `${today}--001--first.ts`,
    );
    assertEquals(at(await newMigration(undefined, dir)), `${today}--002.ts`);
    // An older day doesn't count.
    await Deno.writeTextFile(`${dir}/2000-01-01--007.ts`, "");
    assertEquals(
      at(await newMigration("third", dir)),
      `${today}--003--third.ts`,
    );
    assertEquals(at(await newMigration("x", dir, 42)), `${today}--042--x.ts`);
    await assertRejects(
      () => newMigration("x", dir, 42),
      Deno.errors.AlreadyExists,
    );
  },
);

Deno.test("migration names: parse and next", () => {
  assertEquals(parseMigrationName("2026-09-24--001--first-migration.ts"), {
    id: "2026-09-24--001",
    date: "2026-09-24",
    number: 1,
    name: "first-migration",
  });
  assertEquals(parseMigrationName("2026-09-24--012"), {
    id: "2026-09-24--012",
    date: "2026-09-24",
    number: 12,
  });
  assertEquals(parseMigrationName("2026-13-01--001"), null);
  assertEquals(parseMigrationName("2026-09-24--0001"), null);

  const now = new Date(2026, 8, 24, 0, 30); // local time
  assertEquals(
    nextMigrationName([], "First migration!", now),
    "2026-09-24--001--first-migration",
  );
  assertEquals(
    nextMigrationName(
      ["2026-09-24--001--a.ts", "2026-09-24--004.ts", "2026-09-23--009.ts"],
      undefined,
      now,
    ),
    "2026-09-24--005",
  );
  assertThrows(
    () => nextMigrationName(["2026-09-24--999.ts"], undefined, now),
    Error,
    "1 to 999",
  );
});

Deno.test("migrations: accept modules, as from import()", async () => {
  const path = await tempPath();
  let ran = false;
  const module = Promise.resolve({
    default: migration("2026-01-01--001", () => void (ran = true)),
  });
  const db = await openKRV({ path, tables: usersV1, migrations: [module] });
  db.close();
  assert(ran);
});

Deno.test("migrations: enabled: false is skipped until enabled", async () => {
  const path = await tempPath();
  let runs = 0;
  const up = () => void runs++;

  (
    await openKRV({
      path,
      tables: usersV1,
      migrations: [migration("2026-01-01--001--m1", up, { enabled: false })],
    })
  ).close();
  assertEquals(runs, 0);

  (
    await openKRV({
      path,
      tables: usersV1,
      migrations: [migration("2026-01-01--001--m1", up)],
    })
  ).close();
  assertEquals(runs, 1);
});

Deno.test(
  "migrations: typed API, raw access and transforms inside up",
  async () => {
    const path = await tempPath();
    const tables = [
      table({
        key: ["accounts", "{accountId}"],
        schema: { id: "{accountId}", "emailHash#": "string", name: "string" },
        indexes: { byEmail: { fields: ["emailHash"], unique: true } },
      }),
    ];

    const db = await openKRV({
      path,
      transforms,
      tables,
      migrations: [
        migration("2026-01-01--001--m1", async (db) => {
          await db.insert(["accounts"], { emailHash: "a@x.dev", name: "a" });

          // Raw writes skip transforms and indexes: hash by hand.
          const now = Date.now();
          await db.raw.set(["accounts", "raw"], {
            id: "raw",
            emailHash: await db.transforms["#"].save("raw@x.dev"),
            name: "raw",
            createdAt: now,
            updatedAt: now,
          });
        }),
      ],
    });

    // Indexes were rebuilt after the migration, so the raw row is found.
    const [raw] = await db.list(["accounts"], {
      where: { emailHash: "raw@x.dev" },
    });
    assertEquals(raw.name, "raw");
    const [typed] = await db.list(["accounts"], {
      where: { emailHash: "a@x.dev" },
    });
    assertEquals(typed.name, "a");
    db.close();
  },
);

Deno.test("migrations: a failure restores the backup and throws", async () => {
  const path = await tempPath();
  const first = await openKRV({ path, tables: usersV1 });
  await first.set(["users", "before"], { name: "before" });
  first.close();

  const events: string[] = [];
  await assertRejects(
    () =>
      openKRV({
        path,
        tables: usersV1,
        migrations: [
          migration("2026-01-01--001--ok", async (db) => {
            await db.set(["users", "ok"], { name: "ok" });
          }),
          migration("2026-01-01--002--boom", async (db) => {
            await db.set(["users", "partial"], { name: "partial" });
            throw new Error("boom");
          }),
        ],
        events: {
          migrationFailed: ({ migration, error, backupPath }) => {
            events.push(
              `${migration?.name}:${(error as Error).message}:${backupPath}`,
            );
          },
        },
      }),
    Error,
    "boom",
  );

  assertEquals(events, [`boom:boom:${path}.backup`]);
  assert(!(await exists(`${path}.backup`)), "backup removed after restoring");

  // Everything from this run is gone, including the migration that succeeded.
  const db = await openKRV({ path, tables: usersV1 });
  const names = (await db.list(["users"])).map((u) => u.name);
  assertEquals(names, ["before"]);
  db.close();
});

Deno.test(
  "migrations: events, in order, with the backup in place",
  async () => {
    const path = await tempPath();
    const events: string[] = [];
    const db = await openKRV({
      path,
      tables: usersV1,
      migrations: [
        migration("2026-01-01--001--m1", () => {}),
        migration("2026-01-01--002--m2", () => {}),
      ],
      events: {
        beforeMigrations: async ({ pending, backupPath }) => {
          assert(await exists(backupPath!), "backup exists");
          events.push(`before:${pending.map((m) => m.name)}`);
        },
        beforeMigration: ({ migration }) =>
          void events.push(`start:${migration.name}`),
        afterMigration: ({ migration }) =>
          void events.push(`end:${migration.name}`),
        afterMigrations: ({ applied }) =>
          void events.push(`after:${applied.map((m) => m.name)}`),
      },
    });
    db.close();

    assertEquals(events, [
      "before:m1,m2",
      "start:m1",
      "end:m1",
      "start:m2",
      "end:m2",
      "after:m1,m2",
    ]);
    assert(!(await exists(`${path}.backup`)), "backup removed after success");
  },
);

Deno.test("migrations: a throwing event fails the migrations too", async () => {
  const path = await tempPath();
  await assertRejects(
    () =>
      openKRV({
        path,
        tables: usersV1,
        migrations: [migration("2026-01-01--001--m1", () => {})],
        events: {
          beforeMigrations: () => {
            throw new Error("upload failed");
          },
        },
      }),
    Error,
    "upload failed",
  );
});

Deno.test(
  "schema changes: stale rows without a migration refuse to open",
  async () => {
    const path = await tempPath();
    const v1 = await openKRV({ path, tables: usersV1 });
    await v1.set(["users", "a"], { name: "a" });
    await v1.set(["users", "b"], { name: "b" });
    v1.close();

    const error = await assertRejects(
      () => openKRV({ path, tables: usersV2 }),
      KrvSchemaError,
    );
    assert(error.message.includes('Table "users": 2 invalid row(s)'));
    assert(error.message.includes("users/a.age: required"));

    // The migration that fixes them makes it open.
    const v2 = await openKRV({
      path,
      tables: usersV2,
      migrations: [
        migration("2026-01-01--001--add-age", async (db) => {
          for await (const { key, value } of db.raw.list({
            prefix: ["users"],
          })) {
            await db.raw.set(key, { ...(value as object), age: 0 });
          }
        }),
      ],
    });
    assertEquals((await v2.get(["users", "a"])).value?.age, 0);
    v2.close();
  },
);

Deno.test(
  "schema changes: a migration leaving invalid rows is rolled back",
  async () => {
    const path = await tempPath();
    (await openKRV({ path, tables: usersV2 })).close();

    await assertRejects(
      () =>
        openKRV({
          path,
          tables: usersV2,
          migrations: [
            migration("2026-01-01--001--bad", async (db) => {
              await db.raw.set(["users", "x"], { id: "x", name: 1 });
            }),
          ],
        }),
      KrvSchemaError,
      "after migrations",
    );
    const db = await openKRV({ path, tables: usersV2 });
    assertEquals((await db.list(["users"])).length, 0);
    db.close();
  },
);

Deno.test(
  "schema changes: a new index is built for existing rows",
  async () => {
    const path = await tempPath();
    const v1 = await openKRV({ path, tables: usersV1 });
    await v1.set(["users", "a"], { name: "alice" });
    await v1.set(["users", "b"], { name: "bob" });
    v1.close();

    const indexed = [
      table({
        key: ["users", "{userId}"],
        schema: { id: "{userId}", name: "string" },
        indexes: { byName: { fields: ["name"], unique: true } },
      }),
    ];
    const v2 = await openKRV({ path, tables: indexed });
    const [bob] = await v2.list(["users"], { where: { name: "bob" } });
    assertEquals(bob.id, "b");
    await assertRejects(() => v2.set(["users", "c"], { name: "bob" }));
    v2.close();
  },
);

Deno.test(
  "schema changes: a unique index over duplicate values refuses to open",
  async () => {
    const path = await tempPath();
    const v1 = await openKRV({ path, tables: usersV1 });
    await v1.set(["users", "a"], { name: "same" });
    await v1.set(["users", "b"], { name: "same" });
    v1.close();

    await assertRejects(
      () =>
        openKRV({
          path,
          tables: [
            table({
              key: ["users", "{userId}"],
              schema: { id: "{userId}", name: "string" },
              indexes: { byName: { fields: ["name"], unique: true } },
            }),
          ],
        }),
      KrvSchemaError,
      "duplicates users/a",
    );
  },
);

Deno.test(
  "recovery: a backup left by a crash is restored at open",
  async () => {
    const path = await tempPath();
    const db = await openKRV({ path, tables: usersV1 });
    await db.set(["users", "a"], { name: "a" });
    db.close();

    // Simulate a crash mid-migration: a backup, then a partial write that
    // never finished (no krv involved, so nothing restores it yet).
    await Deno.copyFile(path, `${path}.backup`);
    const kv = await Deno.openKv(path);
    await kv.set(["users", "partial"], { id: "partial", name: "partial" });
    kv.close();

    // The next open sees the leftover backup and restores it first.
    const restored = await openKRV({ path, tables: usersV1 });
    assertEquals(
      (await restored.list(["users"])).map((u) => u.id),
      ["a"],
    );
    assert(!(await exists(`${path}.backup`)));
    restored.close();
  },
);

Deno.test(
  "lock: concurrent opens wait, and a migration runs once",
  async () => {
    const path = await tempPath();
    let runs = 0;
    const migrations = [
      migration("2026-01-01--001--slow", async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 200));
      }),
    ];

    const opens = await Promise.all(
      Array.from({ length: 3 }, () =>
        openKRV({ path, tables: usersV1, migrations }),
      ),
    );
    for (const db of opens) db.close();
    assertEquals(runs, 1);
    assert(!(await exists(`${path}.lock`)));
  },
);

Deno.test(
  "lock: an abandoned lock is taken over after lockTimeout",
  async () => {
    const path = await tempPath();
    await Deno.writeTextFile(`${path}.lock`, "12345");
    const past = new Date(Date.now() - 10_000);
    await Deno.utime(`${path}.lock`, past, past);

    const start = Date.now();
    const db = await openKRV({ path, tables: usersV1, lockTimeout: 1_000 });
    db.close();
    assert(Date.now() - start < 1_000, "didn't wait for a fresh lock");
  },
);

Deno.test("migrations: in memory, a failure just throws", async () => {
  await assertRejects(
    () =>
      openKRV({
        path: ":memory:",
        tables: usersV1,
        migrations: [
          migration("2026-01-01--002--boom", () => {
            throw new Error("boom");
          }),
        ],
      }),
    Error,
    "boom",
  );
});

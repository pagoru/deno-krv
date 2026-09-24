import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type KrvMigration,
  KrvSchemaError,
  openKRV,
  table,
} from "../src/main.ts";
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

const migration = (
  id: string,
  up: KrvMigration["up"],
  extra: Partial<KrvMigration> = {},
): KrvMigration => ({ id, up, ...extra });

Deno.test("migrations: run once each, in id order", async () => {
  const path = await tempPath();
  const ran: string[] = [];
  const migrations = [
    migration("2026-01-02", () => void ran.push("b")),
    migration("2026-01-01", () => void ran.push("a")),
  ];

  const db = await openKRV({ path, tables: usersV1, migrations });
  db.close();
  assertEquals(ran, ["a", "b"]);

  const again = await openKRV({ path, tables: usersV1, migrations });
  again.close();
  assertEquals(ran, ["a", "b"]); // already applied
});

Deno.test("migrations: accept modules, as from import()", async () => {
  const path = await tempPath();
  let ran = false;
  const module = Promise.resolve({
    default: migration("2026-01-01", () => void (ran = true)),
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
      migrations: [migration("m1", up, { enabled: false })],
    })
  ).close();
  assertEquals(runs, 0);

  (
    await openKRV({ path, tables: usersV1, migrations: [migration("m1", up)] })
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
        migration("m1", async (db) => {
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
          migration("ok", async (db) => {
            await db.set(["users", "ok"], { name: "ok" });
          }),
          migration("boom", async (db) => {
            await db.set(["users", "partial"], { name: "partial" });
            throw new Error("boom");
          }),
        ],
        events: {
          migrationFailed: ({ migration, error, backupPath }) => {
            events.push(
              `${migration?.id}:${(error as Error).message}:${backupPath}`,
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
      migrations: [migration("m1", () => {}), migration("m2", () => {})],
      events: {
        beforeMigrations: async ({ pending, backupPath }) => {
          assert(await exists(backupPath!), "backup exists");
          events.push(`before:${pending.map((m) => m.id)}`);
        },
        beforeMigration: ({ migration }) =>
          void events.push(`start:${migration.id}`),
        afterMigration: ({ migration }) =>
          void events.push(`end:${migration.id}`),
        afterMigrations: ({ applied }) =>
          void events.push(`after:${applied.map((m) => m.id)}`),
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
        migrations: [migration("m1", () => {})],
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
        migration("add-age", async (db) => {
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
            migration("bad", async (db) => {
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
      migration("slow", async () => {
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
          migration("boom", () => {
            throw new Error("boom");
          }),
        ],
      }),
    Error,
    "boom",
  );
});

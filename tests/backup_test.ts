import { assert, assertEquals, assertRejects } from "@std/assert";
import { openKRV, table } from "../src/main.ts";
import type { KrvMigration } from "../src/main.ts";

const tempPath = async () => `${await Deno.makeTempDir()}/app.db`;

const members = table({
  key: ["members", "{memberId}"],
  schema: {
    id: "{memberId}",
    name: "string",
    "pin*": "string",
    "nickname#": "string",
    "phone&": "string",
  },
});

const open = (path: string, migrations: KrvMigration[] = []) =>
  openKRV({
    path,
    tables: [members],
    migrations: migrations.map((m) => Promise.resolve({ default: m })),
  });

const member = { name: "ana", pin: "1234", nickname: "an", phone: "+34600" };

Deno.test("backup: restores data and secrets in place", async () => {
  const path = await tempPath();
  const db = await open(path);
  const ana = await db.insert(["members"], member);
  const bytes = await db.backup("hunter2");

  await db.update(["members", ana.id], { name: "changed" });
  await db.insert(["members"], { ...member, name: "bo" });
  await db.restoreBackup(bytes, "hunter2");

  const rows = await db.list(["members"]);
  assertEquals(
    rows.map((r) => r.name),
    ["ana"],
  );
  assertEquals(rows[0].phone, "+34600"); // & decrypts
  assert(await db.compare(["members", ana.id], "pin", "1234")); // *
  const found = await db.find(["members"], { where: { nickname: "an" } }); // #
  assertEquals(found?.id, ana.id);
  db.close();
});

Deno.test("backup: another database takes its secrets too", async () => {
  const source = await open(await tempPath());
  const ana = await source.insert(["members"], member);
  const bytes = await source.backup("pw");
  source.close();

  // A new database: its own, different secrets.
  const path = await tempPath();
  const target = await open(path);
  await target.insert(["members"], { ...member, name: "other" });
  const before = await Deno.readFile(`${path}.secrets`);
  await target.restoreBackup(bytes, "pw");
  assert(
    !before.every((b, i) => b === Deno.readFileSync(`${path}.secrets`)[i]),
  );

  const check = async (db: typeof target) => {
    const row = await db.get(["members", ana.id]);
    assertEquals(row?.phone, "+34600");
    assert(await db.compare(["members", ana.id], "pin", "1234"));
    assertEquals(
      (await db.find(["members"], { where: { nickname: "an" } }))?.id,
      ana.id,
    );
  };
  await check(target);
  target.close();

  // The .secrets file on disk was replaced as well.
  const reopened = await open(path);
  await check(reopened);
  reopened.close();
});

Deno.test("backup: a wrong password changes nothing", async () => {
  const path = await tempPath();
  const db = await open(path);
  const bytes = await db.backup("right");
  await db.insert(["members"], member);
  const secrets = await Deno.readFile(`${path}.secrets`);

  await assertRejects(
    () => db.restoreBackup(bytes, "wrong"),
    Error,
    "Wrong password or damaged backup",
  );
  const altered = bytes.slice();
  altered[altered.length - 1] ^= 1;
  await assertRejects(
    () => db.restoreBackup(altered, "right"),
    Error,
    "Wrong password or damaged backup",
  );
  await assertRejects(
    () => db.restoreBackup(new Uint8Array([1, 2, 3]), "right"),
    Error,
    "Not a krv backup",
  );

  assertEquals((await db.list(["members"])).length, 1);
  assertEquals(await Deno.readFile(`${path}.secrets`), secrets);
  db.close();
});

Deno.test(
  "backup: an older backup gets the migrations it's missing",
  async () => {
    const path = await tempPath();
    const db = await open(path);
    await db.insert(["members"], member);
    const bytes = await db.backup("pw");
    db.close();

    const seed: KrvMigration = {
      url: "file:///migrations/2026-10-01--001--seed.ts",
      up: async (db) => {
        await db.insert(["members"], { ...member, name: "seeded" });
      },
    };
    const migrated = await open(path, [seed]);
    assertEquals((await migrated.list(["members"])).length, 2);

    await migrated.restoreBackup(bytes, "pw");
    const names = (await migrated.list(["members"])).map((r) => r.name);
    assertEquals(names, ["ana", "seeded"]);
    migrated.close();
  },
);

Deno.test("backup: needs a database file and matching secrets", async () => {
  const memory = await openKRV({ path: ":memory:", tables: [members] });
  await assertRejects(() => memory.backup("pw"), Error, "database file");
  memory.close();

  const source = await open(await tempPath());
  const bytes = await source.backup("pw");
  source.close();

  const given = await openKRV({
    path: await tempPath(),
    tables: [members],
    secrets: { key: "k", pepper: "p" },
  });
  await assertRejects(
    () => given.restoreBackup(bytes, "pw"),
    Error,
    "secrets differ",
  );
  given.close();
});

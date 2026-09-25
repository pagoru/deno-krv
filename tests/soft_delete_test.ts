import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  KrvConflictError,
  KrvNotFoundError,
  KrvReferenceError,
  KrvValidationError,
  openKRV,
  table,
} from "../src/main.ts";

/** Waits until `Date.now()` is past `time`. */
const sleepUntil = (time: number) =>
  new Promise((r) => setTimeout(r, Math.max(0, time - Date.now() + 1)));

const tables = [
  table({
    key: ["accounts", "{accountId}"],
    schema: { id: "{accountId}", "username~": "string", "pin*?": "string" },
    indexes: { byUsername: { fields: ["username"], unique: true } },
  }),
  table({
    // Required: soft-deleted with the account.
    key: ["posts", "{postId}"],
    schema: { id: "{postId}", authorId: "{accounts.accountId}" },
  }),
  table({
    // Required to a post: soft-deleted with it, recursively.
    key: ["comments", "{commentId}"],
    schema: { id: "{commentId}", postId: "{posts.postId}" },
  }),
  table({
    // Optional: reads as undefined, cleared by purge.
    key: ["codes", "{codeId}"],
    schema: { id: "{codeId}", "accountId?": "{accounts.accountId}" },
    indexes: { byAccount: { fields: ["accountId"] } },
  }),
  table({
    // Nullable: reads as null, set to null by purge.
    key: ["gifts", "{giftId}"],
    schema: { id: "{giftId}", accountId: ["{accounts.accountId}", null] },
  }),
];

/** A database file, and the same file opened without krv. */
const open = async () => {
  const path = `${await Deno.makeTempDir()}/db`;
  const db = await openKRV({ path, tables });
  const kv = await Deno.openKv(path);
  return {
    db,
    kv,
    [Symbol.dispose]: () => {
      db.close();
      kv.close();
    },
  };
};

const seed = async (db: Awaited<ReturnType<typeof open>>["db"]) => {
  const account = await db.insert(
    ["accounts"],
    {
      username: "Pagoru",
      pin: "1234",
    },
    { values: false },
  );
  const accountId = account.value.id;
  const post = await db.insert(
    ["posts"],
    { authorId: accountId },
    { values: false },
  );
  const comment = await db.insert(
    ["comments"],
    { postId: post.value.id },
    { values: false },
  );
  const code = await db.insert(["codes"], { accountId }, { values: false });
  const gift = await db.insert(["gifts"], { accountId }, { values: false });
  return { account, accountId, post, comment, code, gift };
};

/** Internal keys under a prefix, e.g. `["soft"]`. */
const internal = async (kv: Deno.Kv, ...prefix: Deno.KvKeyPart[]) =>
  (await Array.fromAsync(kv.list({ prefix: ["__krv", ...prefix] }))).map(
    (e) => e.key,
  );

// ---- expireAt ----

Deno.test("expireAt: expireIn is saved as a timestamp and kept", async () => {
  using t = await open();
  const { db } = t;
  const before = Date.now();
  const { key, value } = await db.insert(
    ["accounts"],
    { username: "a" },
    { values: false, expireIn: 60_000 },
  );
  assert(value.expireAt! >= before + 60_000);
  assertEquals((await db.get(key))?.expireAt, value.expireAt);

  // Kept by update, and by a row passed back to set.
  const updated = await db.update(key, { username: "b" });
  assertEquals(updated.expireAt, value.expireAt);
  const row = (await db.get(key))!;
  await db.set(key, { ...row, username: "c" });
  assertEquals((await db.get(key))?.expireAt, value.expireAt);

  // A patch can drop it.
  await db.update(key, { expireAt: undefined });
  assertEquals((await db.get(key))?.expireAt, undefined);
});

Deno.test("expireAt: passed in the value, the row expires then", async () => {
  using t = await open();
  const { db } = t;
  const expireAt = Date.now() + 200;
  const { key } = await db.insert(
    ["accounts"],
    { username: "a", expireAt },
    { values: false },
  );
  const before = await db.get(key);
  // Only certain if the read happened in time (slow runners).
  if (Date.now() < expireAt) assert(before);
  await sleepUntil(expireAt);
  // Hidden once past, even before Deno KV removes it.
  assertEquals(await db.get(key), null);
  assertEquals(await db.list(["accounts"]), []);

  await assertRejects(
    () =>
      db.insert(
        ["accounts"],
        { username: "b", expireAt: Date.now() - 1 },
        { values: false },
      ),
    KrvValidationError,
    "already past",
  );
});

// ---- Soft delete ----

Deno.test("soft: the row and its required children are hidden", async () => {
  using t = await open();
  const { db } = t;
  const { account, post, comment } = await seed(db);

  await db.delete(account.key, { soft: 60_000 });

  assertEquals(await db.get(account.key), null);
  assertEquals(await db.get(post.key), null);
  assertEquals(await db.get(comment.key), null);
  assertEquals(await db.list(["accounts"]), []);
  assertEquals(await db.list(["posts"]), []);
  // Unique lookups don't find it either, nor compare.
  assertEquals(
    await db.find(["accounts"], { where: { username: "pagoru" } }),
    null,
  );
  assert(!(await db.compare(account.key, "pin", "1234")));

  const shown = (await db.get(account.key, { deleted: true }))!;
  assertEquals(shown.username, "pagoru");
  assert(shown.deletedAt! <= Date.now());
  assert(shown.expireAt! > Date.now());
  assertEquals((await db.list(["comments"], { deleted: true })).length, 1);
});

Deno.test(
  "soft: optional references read as unset, deleted: true shows them",
  async () => {
    using t = await open();
    const { db } = t;
    const { account, accountId, code, gift } = await seed(db);

    await db.delete(account.key, { soft: 60_000 });

    const codeRow = (await db.get(code.key))!;
    assertEquals(codeRow.accountId, undefined);
    assertEquals((await db.get(gift.key))!.accountId, null);
    assertEquals(
      (await db.get(code.key, { deleted: true }))!.accountId,
      accountId,
    );

    // `where` on the reference doesn't find them, unless deleted: true.
    assertEquals(await db.list(["codes"], { where: { accountId } }), []);
    assertEquals(
      (await db.list(["codes"], { where: { accountId }, deleted: true }))
        .length,
      1,
    );

    // Expands: forward gives null, reverse leaves soft-deleted rows out.
    const expanded = await db.get(code.key, {
      expand: { account: "accountId" },
    });
    assertEquals(expanded!.account, null);
    const withAccount = await db.get(code.key, {
      deleted: true,
      expand: { account: { from: "accountId", expand: {} } },
    });
    assertEquals(withAccount!.account?.id, accountId);
    const shown = await db.get(account.key, {
      deleted: true,
      expand: { posts: "posts.authorId" },
    });
    assertEquals(shown!.posts.length, 1);
  },
);

Deno.test("soft: restore brings the whole group back", async () => {
  using t = await open();
  const { db, kv } = t;
  const { account, post, comment, code } = await seed(db);

  await db.delete(account.key, { soft: 60_000 });
  // Restoring any member restores the group.
  await db.restore(comment.key);

  assertEquals(await db.get(account.key), account.value);
  assertEquals(await db.get(post.key), post.value);
  assertEquals(await db.get(comment.key), comment.value);
  assertEquals((await db.get(code.key))!.accountId, account.value.id);
  assertEquals(await internal(kv, "soft"), []);
  assertEquals(await internal(kv, "softOf"), []);

  await assertRejects(() => db.restore(account.key), KrvNotFoundError);
});

Deno.test("soft: restore keeps an expireAt from before", async () => {
  using t = await open();
  const { db } = t;
  const { key, value } = await db.insert(
    ["accounts"],
    { username: "a" },
    { values: false, expireIn: 120_000 },
  );
  await db.delete(key, { soft: 60_000 });
  assert((await db.get(key, { deleted: true }))!.expireAt! < value.expireAt!);
  await db.restore(key);
  assertEquals((await db.get(key))!.expireAt, value.expireAt);
});

Deno.test("soft: unique values stay taken, writes are rejected", async () => {
  using t = await open();
  const { db } = t;
  const { account, accountId } = await seed(db);
  await db.delete(account.key, { soft: 60_000 });

  await assertRejects(
    () => db.insert(["accounts"], { username: "PAGORU" }, { values: false }),
    KrvConflictError,
    "unique",
  );
  await assertRejects(
    () => db.insert(["posts"], { authorId: accountId }, { values: false }),
    KrvReferenceError,
  );
  await assertRejects(
    () => db.update(account.key, { username: "x" }),
    KrvConflictError,
    "soft-deleted",
  );
  await assertRejects(
    () => db.delete(account.key, { soft: 1000 }),
    KrvConflictError,
    "already soft-deleted",
  );
});

for (const expired of [false, true]) {
  Deno.test(
    `soft: purge clears references${expired ? " (rows already expired)" : ""}`,
    async () => {
      using t = await open();
      const { db, kv } = t;
      const { account, post, comment, code, gift } = await seed(db);

      // purgeAt is between `start + soft` and `deleted + soft`.
      const soft = 200;
      const start = Date.now();
      await db.delete(account.key, { soft });
      const deleted = Date.now();
      const early = await db.purge();
      // Not due yet, if this ran in time (slow runners).
      if (Date.now() <= start + soft) assertEquals(early, 0);
      await sleepUntil(deleted + soft);
      if (expired) {
        // What Deno KV does by itself, some time after expireAt.
        for (const key of [account.key, post.key, comment.key]) {
          await kv.delete(key);
        }
      }
      assertEquals(await db.purge(), 1);

      for (const key of [account.key, post.key, comment.key]) {
        assertEquals((await kv.get(key)).versionstamp, null);
      }
      const codeRow = (await kv.get<Record<string, unknown>>(code.key)).value!;
      assert("accountId" in codeRow);
      assertEquals(codeRow.accountId, undefined);
      assertEquals(
        (await kv.get<Record<string, unknown>>(gift.key)).value!.accountId,
        null,
      );
      assertEquals(await internal(kv, "soft"), []);
      assertEquals(await internal(kv, "softOf"), []);
      assertEquals(await internal(kv, "index", "codes"), []);
      assertEquals(await internal(kv, "index", "gifts"), []);
      assertEquals(await internal(kv, "refs"), []);
      assertEquals(await db.purge(), 0);

      // The id and username are free again.
      await db.insert(["accounts"], {
        id: account.value.id,
        username: "pagoru",
      });
    },
  );
}

Deno.test("soft: deleting a soft-deleted row purges it now", async () => {
  using t = await open();
  const { db, kv } = t;
  const { account, post, code } = await seed(db);

  await db.delete(account.key, { soft: 60_000 });
  await db.delete(account.key);

  assertEquals((await kv.get(account.key)).versionstamp, null);
  assertEquals((await kv.get(post.key)).versionstamp, null);
  assertEquals((await db.get(code.key))!.accountId, undefined);
  assertEquals(await internal(kv, "soft"), []);
  await assertRejects(() => db.restore(account.key), KrvNotFoundError);
});

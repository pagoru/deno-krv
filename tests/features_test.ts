import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  defineKRV,
  KrvConflictError,
  KrvNotFoundError,
  KrvReferenceError,
  KrvSchemaError,
  KrvValidationError,
  openKRV,
  table,
} from "../src/main.ts";
import { fulfilled, rejected, settle } from "./_helpers.ts";
import { transforms } from "./_crypto.ts";
import { loadSecrets } from "../src/secrets.ts";
import { createDefaultTransforms } from "../src/transforms.ts";

// The shared example: accounts, transactions, gift codes and admins.
const tables = [
  table({
    key: ["accounts", "{accountId}"],
    schema: {
      id: "{accountId}",
      "emailHash#": "email", // sha256: searchable, not readable
      "email&": "email", // encrypted: readable, not searchable
      "password*": "str(8, 72)", // salted hash: only checkable with compare
      "username?": "str(3, 20)",
      "tokens[]&?": "string",
      verified: "boolean",
    },
    indexes: {
      byEmail: { fields: ["emailHash"], unique: true },
      byUsername: { fields: ["username"], unique: true },
    },
  }),
  table({
    key: ["transactions", "{transactionId}"],
    schema: {
      id: "{transactionId}",
      accountId: ["{accounts.accountId}", null],
      amount: "positive",
      currency: ["|eur|", "|usd|"],
      status: ["|pending|", "|succeeded|", "|failed|"],
      type: ["|purchase|", "|gift|"],
      "stripePaymentIntent?": "string",
      meta: { source: ["|web|", "|app|", "|migration|"], "note?": "string" },
      "tags[]": "string",
    },
    indexes: {
      byPaymentIntent: { fields: ["stripePaymentIntent"], unique: true },
      byStatus: { fields: ["accountId", "status"] },
    },
  }),
  table({
    key: ["codes", "{codeId}"],
    schema: {
      id: "{codeId}",
      transactionId: "{transactions.transactionId}",
      "codeHash#": "string",
      "code&": "string",
      description: "string",
    },
    indexes: { byCode: { fields: ["codeHash"], unique: true } },
  }),
  table({
    key: ["admins", "{accountId}"],
    schema: { accountId: "{accounts.accountId}" },
  }),
  table({
    key: ["config"],
    schema: { maintenance: "boolean" },
    timestamps: false,
  }),
];

const open = (path = ":memory:") =>
  openKRV({
    path,
    validators: {
      email: ["string", (v) => v.includes("@")],
      positive: ["number", (n) => n > 0],
      "str(min, max)": [
        "string",
        (s, { min, max }: { min: number; max: number }) =>
          s.length >= min && s.length <= max,
      ],
    },
    transforms,
    tables,
  });

type Db = Awaited<ReturnType<typeof open>>;

const account = (db: Db, email: string, extra: { username?: string } = {}) =>
  db.insert(["accounts"], {
    emailHash: email,
    email,
    password: `${email}-password`,
    verified: true,
    ...extra,
  });

const transaction = (
  db: Db,
  accountId: string | null,
  extra: Record<string, unknown> = {},
) =>
  db.insert(["transactions"], {
    accountId,
    amount: 695,
    currency: "eur",
    status: "succeeded",
    type: "gift",
    meta: { source: "web" },
    tags: ["gift"],
    ...extra,
  } as never);

/** Reads stored values directly, bypassing krv. */
const raw = async (path: string, key: Deno.KvKey) => {
  const kv = await Deno.openKv(path);
  try {
    return (await kv.get<Record<string, unknown>>(key)).value;
  } finally {
    kv.close();
  }
};

const tempPath = async () => `${await Deno.makeTempDir()}/db`;

// ---- Timestamps ----

Deno.test(
  "timestamps: insert sets both, set keeps createdAt and bumps updatedAt",
  async () => {
    const db = await open();
    const before = Date.now();
    const { key, value } = await account(db, "a@x.dev");
    assert(value.createdAt >= before && value.createdAt === value.updatedAt);

    await new Promise((r) => setTimeout(r, 5));
    await db.set(key, { ...value, verified: false }); // spread: old updatedAt
    const updated = (await db.get(key)).value!;
    assertEquals(updated.createdAt, value.createdAt);
    assert(updated.updatedAt > value.updatedAt);
    db.close();
  },
);

Deno.test("timestamps: can be set explicitly, on insert and set", async () => {
  const db = await open();
  const { key, value } = await account(db, "a@x.dev", {});
  await db.set(key, { ...value, createdAt: 1, updatedAt: 2 });
  const row = (await db.get(key)).value!;
  assertEquals([row.createdAt, row.updatedAt], [1, 2]);

  const other = await db.insert(["accounts"], {
    emailHash: "b@x.dev",
    email: "b@x.dev",
    password: "12345678",
    verified: true,
    createdAt: 10,
    updatedAt: 20,
  });
  assertEquals([other.value.createdAt, other.value.updatedAt], [10, 20]);
  db.close();
});

Deno.test("timestamps: timestamps: false leaves them out", async () => {
  const db = await open();
  await db.set(["config"], { maintenance: false });
  assertEquals((await db.get(["config"])).value, { maintenance: false });
  db.close();
});

// ---- Transforms ----

Deno.test(
  "transforms: stored values are transformed, reads load them back",
  async () => {
    const path = await tempPath();
    const db = await open(path);
    const { key, value } = await account(db, "a@x.dev");
    db.close();

    const stored = (await raw(path, key))!;
    assertEquals((stored.emailHash as string).length, 64); // sha256 hex
    assert((stored.email as string).startsWith("enc:"));
    assert((stored.password as string).startsWith("$fake$"));

    const reopened = await open(path);
    const read = (await reopened.get(key)).value!;
    assertEquals(read.email, "a@x.dev"); // "&" has load: decrypted
    assertEquals(read.emailHash, stored.emailHash); // "#" has no load: the hash
    assertEquals(read.password, stored.password); // "*" has no load: the hash
    assertEquals(value.email, "a@x.dev");
    assertEquals(value.password, stored.password);
    reopened.close();
  },
);

Deno.test("transforms: arrays are transformed item by item", async () => {
  const path = await tempPath();
  const db = await open(path);
  const { key } = await db.insert(["accounts"], {
    emailHash: "a@x.dev",
    email: "a@x.dev",
    password: "12345678",
    verified: true,
    tokens: ["t1", "t2"],
  });
  assertEquals((await db.get(key)).value!.tokens, ["t1", "t2"]);
  db.close();

  const stored = (await raw(path, key))!.tokens as string[];
  assert(stored.every((t) => t.startsWith("enc:")));
});

Deno.test("transforms: validation runs on the plain value", async () => {
  const db = await open();
  await assertRejects(
    () =>
      db.insert(["accounts"], {
        emailHash: "a@x.dev",
        email: "a@x.dev",
        password: "short",
        verified: true,
      }),
    KrvValidationError,
    'accounts.password: "short" is not a valid str(8, 72)',
  );
  db.close();
});

Deno.test(
  "transforms: an opaque value passed back unchanged isn't hashed again",
  async () => {
    const db = await open();
    const { key, value } = await account(db, "a@x.dev");
    await db.set(key, { ...value, verified: false });

    assert(await db.compare(key, "password", "a@x.dev-password"));
    assertEquals((await db.get(key)).value!.emailHash, value.emailHash);
    // A new password is hashed.
    await db.set(key, { ...value, password: "new-password" });
    assert(await db.compare(key, "password", "new-password"));
    db.close();
  },
);

Deno.test("transforms: compare", async () => {
  const db = await open();
  const { key } = await account(db, "a@x.dev");

  assert(await db.compare(key, "password", "a@x.dev-password")); // compare()
  assert(!(await db.compare(key, "password", "wrong")));
  assert(await db.compare(key, "emailHash", "a@x.dev")); // deterministic
  assert(await db.compare(key, "email", "a@x.dev")); // load
  assert(!(await db.compare(["accounts", "ghost"], "password", "x")));
  await assertRejects(
    () => db.compare(key, "verified", true),
    Error,
    "no transform",
  );
  db.close();
});

Deno.test(
  "transforms: where hashes the value first; non-deterministic fields can't be searched",
  async () => {
    const db = await open();
    await account(db, "a@x.dev");
    await account(db, "b@x.dev");

    const [found] = await db.list(["accounts"], {
      where: { emailHash: "b@x.dev" },
    });
    assertEquals(found.email, "b@x.dev");

    assertThrows(
      // @ts-expect-error "&" isn't deterministic
      () => db.list(["accounts"], { where: { email: "a@x.dev" } }),
      Error,
      "isn't deterministic",
    );
    assertThrows(
      // @ts-expect-error "*" isn't deterministic
      () => db.list(["accounts"], { where: { password: "x" } }),
      Error,
      "isn't deterministic",
    );
    db.close();
  },
);

const pinned = [
  table({
    key: ["pinned", "{memberId}"],
    schema: {
      id: "{memberId}",
      "pin*": "string",
      "nickname#": "string",
      "phone&?": "string",
      "tags[]&?": "string",
      "age&?": "number",
    },
    indexes: { byPhone: { fields: ["phone"], using: "#" } },
  }),
];

/** What the built-in `#` stores for `value` with `key`. */
const hashWith = (key: string, value: string) =>
  createDefaultTransforms(() => ({ key }))["#"].save(value);

Deno.test(
  "transforms: # (HMAC) and * (peppered bcrypt) work without declaring them",
  async () => {
    const path = await tempPath();
    const db = await openKRV({ path, tables: pinned });
    const { key, value } = await db.insert(["pinned"], {
      pin: "1234",
      nickname: "ana",
    });
    db.close();

    // Secrets are created next to the database, in one binary file readable
    // by the owner only.
    const file = await Deno.readFile(`${path}.secrets`);
    assertEquals(new TextDecoder().decode(file.subarray(0, 4)), "KRVS");
    assertEquals(file.length, 4 + 1 + 32 + 32);
    assertEquals((await Deno.stat(`${path}.secrets`)).mode! & 0o777, 0o600);
    const secret = Array.from(file.subarray(5, 37), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    const stored = (await raw(path, key))!;
    assertEquals(stored.nickname, await hashWith(secret, "ana"));
    assert((stored.pin as string).startsWith("$2a$10$"));
    assertEquals(value.pin, stored.pin);

    // Reopened, the same secrets are read back.
    const reopened = await openKRV({ path, tables: pinned });
    assertEquals(await Deno.readFile(`${path}.secrets`), file);
    assert(await reopened.compare(key, "pin", "1234"));
    assert(!(await reopened.compare(key, "pin", "4321")));
    assert(await reopened.compare(key, "nickname", "ana"));
    const [found] = await reopened.list(["pinned"], {
      where: { nickname: "ana" },
    });
    assertEquals(found.id, value.id);
    assertThrows(
      // @ts-expect-error "*" isn't deterministic
      () => reopened.list(["pinned"], { where: { pin: "1234" } }),
      Error,
      "isn't deterministic",
    );
    reopened.close();
  },
);

Deno.test(
  "transforms: & (AES-GCM) encrypts, reads back decrypted, searchable through #",
  async () => {
    const path = await tempPath();
    const db = await openKRV({ path, tables: pinned });
    const a = await db.insert(["pinned"], {
      pin: "1234",
      nickname: "ana",
      phone: "+34600000000",
      tags: ["x", "y"],
      age: 30,
    });
    const b = await db.insert(["pinned"], {
      pin: "1234",
      nickname: "bea",
      phone: "+34600000000",
    });
    assertEquals(a.value.phone, "+34600000000");
    assertEquals(a.value.age, 30);
    db.close();

    const stored = (await raw(path, a.key))!;
    const other = (await raw(path, b.key))!;
    assert(!(stored.phone as string).includes("600"));
    // Random nonce: the same value encrypts differently each time.
    assertNotEquals(stored.phone, other.phone);
    assertEquals((stored.tags as string[]).length, 2);

    const reopened = await openKRV({ path, tables: pinned });
    const read = (await reopened.get(a.key)).value!;
    assertEquals(read.phone, "+34600000000");
    assertEquals(read.tags, ["x", "y"]);
    assertEquals(read.age, 30); // numbers come back as numbers
    assert(await reopened.compare(a.key, "phone", "+34600000000"));
    const found = await reopened.list(["pinned"], {
      where: { phone: "+34600000000" },
    });
    assertEquals(found.length, 2);
    reopened.close();

    // Another key can't decrypt it.
    const wrong = await openKRV({
      path,
      secrets: { key: "wrong", pepper: "wrong" },
      tables: pinned,
    });
    await assertRejects(() => wrong.get(a.key));
    wrong.close();
  },
);

Deno.test("transforms: replacing all three means no secrets file", async () => {
  const path = await tempPath();
  const db = await openKRV({ path, transforms, tables: pinned });
  db.close();
  await assertRejects(() => Deno.stat(`${path}.secrets`), Deno.errors.NotFound);
});

Deno.test("transforms: a damaged secrets file is rejected", async () => {
  const path = await tempPath();
  await Deno.writeTextFile(`${path}.secrets`, "not secrets");
  await assertRejects(
    () => openKRV({ path, tables: pinned }),
    Error,
    "isn't a krv secrets file",
  );
});

Deno.test(
  "transforms: * accepts passwords over bcrypt's 72 bytes",
  async () => {
    const db = await openKRV({ path: ":memory:", tables: pinned });
    const pin = "x".repeat(200);
    const { key } = await db.insert(["pinned"], { pin, nickname: "ana" });
    assert(await db.compare(key, "pin", pin));
    assert(!(await db.compare(key, "pin", pin.slice(0, 72))));
    db.close();
  },
);

Deno.test("transforms: declared ones replace only their default", async () => {
  const path = await tempPath();
  const db = await openKRV({
    path,
    transforms: { "*": transforms["*"] },
    tables: pinned,
  });
  const { key } = await db.insert(["pinned"], {
    pin: "1234",
    nickname: "ana",
  });
  db.close();

  const stored = (await raw(path, key))!;
  assert((stored.pin as string).startsWith("$fake$"));
  const { key: secret } = await loadSecrets(path, undefined, true);
  assertEquals(stored.nickname, await hashWith(secret!, "ana"));
});

Deno.test("transforms: secrets passed to openKRV aren't written", async () => {
  const path = await tempPath();
  const secrets = { key: "my-key", pepper: "my-pepper" };
  const db = await openKRV({ path, secrets, tables: pinned });
  const { key } = await db.insert(["pinned"], {
    pin: "1234",
    nickname: "ana",
  });
  db.close();

  assertEquals(
    (await raw(path, key))!.nickname,
    await hashWith("my-key", "ana"),
  );
  await assertRejects(() => Deno.stat(`${path}.secrets`), Deno.errors.NotFound);

  // Another pepper doesn't match.
  const other = await openKRV({
    path,
    secrets: { ...secrets, pepper: "other" },
    tables: pinned,
  });
  assert(!(await other.compare(key, "pin", "1234")));
  other.close();
});

Deno.test(
  "transforms: without secrets or a file, #, * and & throw",
  async () => {
    const secrets = await loadSecrets(undefined, undefined, true);
    const defaults = createDefaultTransforms(() => secrets);
    await assertRejects(() => defaults["#"].save("x"), Error, "needs a key");
    await assertRejects(() => defaults["*"].save("x"), Error, "needs a pepper");
    await assertRejects(() => defaults["&"].save("x"), Error, "needs a key");
  },
);

// ---- Indexes ----

Deno.test(
  "indexes: unique values are enforced on insert and update",
  async () => {
    const db = await open();
    const a = await account(db, "a@x.dev", { username: "alice" });
    const b = await account(db, "b@x.dev");

    await assertRejects(
      () => account(db, "a@x.dev"),
      KrvConflictError,
      "byEmail",
    );
    await assertRejects(
      () => db.set(b.key, { ...b.value, username: "alice" }),
      KrvConflictError,
      "already taken by accounts/",
    );
    // Rows without a username aren't indexed, so any number of them is fine.
    await account(db, "c@x.dev");

    // Freed values can be taken again.
    await db.set(a.key, { ...a.value, username: "alice2" });
    await db.set(b.key, { ...b.value, username: "alice" });
    await db.delete(a.key);
    await account(db, "a@x.dev");
    db.close();
  },
);

Deno.test(
  "indexes: concurrent inserts of the same unique value, one wins",
  async () => {
    const db = await open();
    const results = await settle(
      Array.from({ length: 20 }, () => account(db, "same@x.dev")),
    );
    assertEquals(fulfilled(results).length, 1);
    assert(
      rejected(results).every((r) => r.reason instanceof KrvConflictError),
    );
    assertEquals((await db.list(["accounts"])).length, 1);
    db.close();
  },
);

Deno.test("indexes: where uses them, and they follow updates", async () => {
  const db = await open();
  const alice = await account(db, "a@x.dev", { username: "alice" });
  const bob = await account(db, "b@x.dev");
  const t1 = await transaction(db, alice.value.id, { status: "pending" });
  await transaction(db, alice.value.id);
  await transaction(db, bob.value.id);

  const byStatus = (status: "pending" | "succeeded") =>
    db.list(["transactions"], { where: { accountId: alice.value.id, status } });

  assertEquals((await byStatus("pending")).length, 1);
  assertEquals((await byStatus("succeeded")).length, 1);

  await db.set(t1.key, { ...t1.value, status: "succeeded" });
  assertEquals((await byStatus("pending")).length, 0);
  assertEquals((await byStatus("succeeded")).length, 2);

  const [byName] = await db.list(["accounts"], {
    where: { username: "alice" },
  });
  assertEquals(byName.id, alice.value.id);
  db.close();
});

Deno.test("indexes: invalid definitions are rejected at open", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ i: { fields: ["nope"] } }, 'unknown field "nope"'],
    [{ i: { fields: ["email"] } }, "isn't deterministic"],
    [{ i: { fields: ["tokens"] } }, "is an array or map"],
    [{ i: { fields: [] } }, "needs at least one field"],
  ];
  for (const [indexes, message] of cases) {
    await assertRejects(
      () =>
        openKRV({
          path: ":memory:",
          transforms,
          tables: [
            table({
              key: ["t", "{id}"],
              schema: { id: "{id}", "email&": "string", "tokens[]": "string" },
              indexes: indexes as never,
            }),
          ],
        }),
      KrvSchemaError,
      message,
    );
  }
});

// ---- where and filter ----

Deno.test("where: nested objects match partially", async () => {
  const db = await open();
  const a = await account(db, "a@x.dev");
  await transaction(db, a.value.id, { meta: { source: "app", note: "x" } });
  await transaction(db, a.value.id, { meta: { source: "web" } });

  const app = await db.list(["transactions"], {
    where: { meta: { source: "app" } },
  });
  assertEquals(
    app.map((t) => t.meta),
    [{ source: "app", note: "x" }],
  );
  db.close();
});

Deno.test(
  "filter: any condition, typed, after where and before limit",
  async () => {
    const db = await open();
    const a = await account(db, "a@x.dev");
    for (const amount of [100, 700, 800, 50, 900]) {
      await transaction(db, a.value.id, { amount });
    }

    const big = await db.list(["transactions"], {
      where: { accountId: a.value.id },
      filter: (t) => t.amount > 500 && t.tags.includes("gift"),
      limit: 2,
    });
    assertEquals(
      big.map((t) => t.amount),
      [700, 800],
    );
    db.close();
  },
);

// ---- Nullable references ----

Deno.test(
  "references: a nullable reference may be null, and is enforced otherwise",
  async () => {
    const db = await open();
    const gift = await transaction(db, null);
    assertEquals(gift.value.accountId, null);

    await assertRejects(() => transaction(db, "ghost"), KrvReferenceError);

    const a = await account(db, "a@x.dev");
    await transaction(db, a.value.id);
    await assertRejects(() => db.delete(a.key), KrvReferenceError);
    await db.delete(a.key, { cascade: true });
    assertEquals((await db.list(["transactions"])).length, 1); // the null one
    db.close();
  },
);

Deno.test(
  "references: 1:1 table keyed by the reference, cascades",
  async () => {
    const db = await open();
    const a = await account(db, "a@x.dev");
    await db.insert(["admins"], { accountId: a.value.id });
    assertNotEquals((await db.get(["admins", a.value.id])).value, null);

    await db.delete(a.key, { cascade: true });
    assertEquals((await db.get(["admins", a.value.id])).value, null);
    db.close();
  },
);

// ---- Indexes using a transform (blind indexes) ----

const members = [
  table({
    key: ["members", "{memberId}"],
    schema: { id: "{memberId}", club: "string", "phone&": "string" },
    indexes: {
      byPhone: { fields: ["phone"], using: "#", unique: true },
      byClubPhone: { fields: ["club", "phone"], using: { phone: "#" } },
    },
  }),
];

const openMembers = (path = ":memory:") =>
  openKRV({ path, transforms, tables: members });

Deno.test(
  "using: where on an encrypted field goes through its hashed index",
  async () => {
    const path = await tempPath();
    const db = await openMembers(path);
    const a = await db.insert(["members"], { club: "chess", phone: "+34600" });
    await db.insert(["members"], { club: "chess", phone: "+34611" });

    const [found] = await db.list(["members"], { where: { phone: "+34600" } });
    assertEquals(found.id, a.value.id);
    assertEquals(found.phone, "+34600");
    assertEquals(
      (
        await db.list(["members"], {
          where: { club: "chess", phone: "+34611" },
        })
      ).length,
      1,
    );
    db.close();

    // Stored encrypted; the index is keyed by the hash of the plain value.
    const kv = await Deno.openKv(path);
    const stored = (await kv.get<{ phone: string }>(a.key)).value!;
    assert(stored.phone.startsWith("enc:"));
    const unique = await kv.get([
      "__krv",
      "uniq",
      "members",
      "byPhone",
      await transforms["#"].save("+34600"),
    ]);
    assertEquals(unique.value, a.key);
    kv.close();
  },
);

Deno.test(
  "using: unique, updates and deletes follow the plain value",
  async () => {
    const db = await openMembers();
    const a = await db.insert(["members"], { club: "go", phone: "+1" });

    await assertRejects(
      () => db.insert(["members"], { club: "go", phone: "+1" }),
      KrvConflictError,
      "byPhone",
    );

    await db.set(a.key, { ...a.value, phone: "+2" });
    assertEquals(
      (await db.list(["members"], { where: { phone: "+1" } })).length,
      0,
    );
    assertEquals(
      (await db.list(["members"], { where: { phone: "+2" } })).length,
      1,
    );

    // Written back unchanged (decrypted value in a spread): index untouched.
    const current = (await db.get(a.key)).value!;
    await db.set(a.key, { ...current, club: "chess" });
    assertEquals(
      (await db.list(["members"], { where: { phone: "+2" } })).length,
      1,
    );

    await db.delete(a.key);
    await db.insert(["members"], { club: "go", phone: "+2" }); // freed
    db.close();
  },
);

Deno.test(
  "using: an encrypted field without such an index can't be searched",
  async () => {
    const db = await openKRV({
      path: ":memory:",
      transforms,
      tables: [
        table({
          key: ["notes", "{noteId}"],
          schema: { id: "{noteId}", "secret&": "string" },
        }),
      ],
    });
    assertThrows(
      // @ts-expect-error no index using a deterministic transform
      () => db.list(["notes"], { where: { secret: "x" } }),
      Error,
      'using: "#"',
    );
    db.close();
  },
);

Deno.test(
  "using: the transform a field is already stored with indexes it as stored",
  async () => {
    const db = await openKRV({
      path: ":memory:",
      transforms,
      tables: [
        table({
          key: ["users", "{userId}"],
          schema: { id: "{userId}", "email#": "string" },
          indexes: { byEmail: { fields: ["email"], using: "#", unique: true } },
        }),
      ],
    });
    await db.insert(["users"], { email: "a@x.dev" });
    const [found] = await db.list(["users"], { where: { email: "a@x.dev" } });
    assertEquals(found.email, await transforms["#"].save("a@x.dev"));
    await assertRejects(
      () => db.insert(["users"], { email: "a@x.dev" }),
      KrvConflictError,
    );
    db.close();
  },
);

Deno.test("using: invalid definitions are rejected at open", async () => {
  const cases: [Record<string, unknown>, string][] = [
    [
      { i: { fields: ["phone"], using: "&" } },
      "needs a deterministic transform",
    ],
    [{ i: { fields: ["phone"], using: "!" } }, 'unknown transform "!"'],
    [{ i: { fields: ["pin"], using: "#" } }, "has no load"],
    [
      { i: { fields: ["phone"], using: { club: "#" } } },
      "isn't one of its fields",
    ],
  ];
  for (const [indexes, message] of cases) {
    await assertRejects(
      () =>
        openKRV({
          path: ":memory:",
          transforms,
          tables: [
            table({
              key: ["t", "{id}"],
              schema: { id: "{id}", "phone&": "string", "pin*": "string" },
              indexes: indexes as never,
            }),
          ],
        }),
      KrvSchemaError,
      message,
    );
  }
});

Deno.test(
  "using: added later, the index is built from existing encrypted rows",
  async () => {
    const path = await tempPath();
    const plainTables = [
      table({
        key: ["members", "{memberId}"],
        schema: { id: "{memberId}", club: "string", "phone&": "string" },
      }),
    ];
    const v1 = await openKRV({ path, transforms, tables: plainTables });
    const a = await v1.insert(["members"], { club: "go", phone: "+9" });
    v1.close();

    const v2 = await openMembers(path);
    const [found] = await v2.list(["members"], { where: { phone: "+9" } });
    assertEquals(found.id, a.value.id);
    v2.close();
  },
);

// ---- list values ----

Deno.test(
  "list: returns just the rows, or entries with values: false",
  async () => {
    const db = await open();
    await account(db, "a@x.dev", { username: "alice" });
    await account(db, "b@x.dev");

    const rows = await db.list(["accounts"]);
    assertEquals(
      rows.map((a) => a.email),
      ["a@x.dev", "b@x.dev"],
    );
    assert(!("key" in rows[0]));

    // Typed as rows, and works with where, filter and streaming.
    const names: (string | undefined)[] = [];
    for await (const a of db.list(["accounts"], {
      filter: (a) => a.verified,
      where: { emailHash: "a@x.dev" },
    }))
      names.push(a.username);
    assertEquals(names, ["alice"]);

    // values: false: entries, with key and versionstamp.
    const [entry] = await db.list(["accounts"], { limit: 1, values: false });
    assertEquals(entry.key[0], "accounts");
    assertEquals(entry.value.email, "a@x.dev");
    db.close();
  },
);

Deno.test("find: the first matching row, or null", async () => {
  const db = await open();
  const a = await account(db, "a@x.dev", { username: "alice" });
  await account(db, "b@x.dev");

  const byHash = await db.find(["accounts"], {
    where: { emailHash: "b@x.dev" },
  });
  assertEquals(byHash?.email, "b@x.dev");

  const first = await db.find(["accounts"]);
  assertEquals(first?.id, a.value.id);
  const last = await db.find(["accounts"], { reverse: true });
  assertEquals(last?.email, "b@x.dev");

  const filtered = await db.find(["accounts"], { filter: (x) => !x.username });
  assertEquals(filtered?.email, "b@x.dev");

  assertEquals(
    await db.find(["accounts"], { where: { username: "nobody" } }),
    null,
  );

  const entry = await db.find(["accounts"], {
    where: { username: "alice" },
    values: false,
  });
  assertEquals(entry?.key, a.key);

  // @ts-expect-error unknown table
  await assertRejects(() => db.find(["nope"]), Error, "No table with key nope");
  db.close();
});

// ---- update ----

Deno.test(
  "update: merges nested objects, replaces arrays and maps",
  async () => {
    const db = await open();
    const a = await account(db, "a@x.dev");
    const t = await transaction(db, a.value.id, {
      meta: { source: "web", note: "x" },
      tags: ["a", "b"],
    });

    const updated = await db.update(t.key, {
      meta: { note: "y" },
      tags: ["c"],
    });
    assertEquals(updated.meta, { source: "web", note: "y" }); // merged
    assertEquals(updated.tags, ["c"]); // replaced
    assert(updated.updatedAt >= t.value.updatedAt);
    assertEquals((await db.get(t.key)).value!.meta.note, "y");
    db.close();
  },
);

Deno.test("update: undefined removes a field", async () => {
  const db = await open();
  const a = await account(db, "a@x.dev", { username: "alice" });

  const removed = await db.update(a.key, { username: undefined });
  assertEquals("username" in removed, false);
  // Freed from the unique index too.
  await account(db, "b@x.dev", { username: "alice" });

  await assertRejects(
    () => db.update(a.key, { verified: undefined }),
    KrvValidationError,
    "accounts.verified: required",
  );
  db.close();
});

Deno.test(
  "update: keeps hashes, updates indexes, returns the row",
  async () => {
    const db = await open();
    const a = await account(db, "a@x.dev");

    const updated = await db.update(a.key, { verified: false });
    assertEquals(updated.verified, false);
    assertEquals(updated.email, "a@x.dev"); // decrypted
    assert(await db.compare(a.key, "password", "a@x.dev-password")); // not re-hashed
    db.close();
  },
);

Deno.test(
  "update: a function patch never loses concurrent updates",
  async () => {
    const db = await open();
    const a = await account(db, "a@x.dev");
    const t = await transaction(db, a.value.id, { amount: 1 });

    await Promise.all(
      Array.from({ length: 30 }, () =>
        db.update(t.key, (tx) => ({ amount: tx.amount + 1 })),
      ),
    );
    assertEquals((await db.get(t.key)).value!.amount, 31);
    db.close();
  },
);

Deno.test(
  "update: missing rows throw, check guards against stale versions",
  async () => {
    const db = await open();
    await assertRejects(
      () => db.update(["accounts", "ghost"], { verified: true }),
      KrvNotFoundError,
      "Not found: accounts/ghost",
    );

    const a = await account(db, "a@x.dev");
    const [read] = await db.list(["accounts"], { values: false });
    await db.update(a.key, { verified: false }); // someone else
    await assertRejects(
      () => db.update(a.key, { verified: true }, { check: read.versionstamp }),
      KrvConflictError,
    );
    db.close();
  },
);

Deno.test("tables: optional, so a database can start without any", async () => {
  const db = await openKRV({ path: ":memory:" });
  db.close();

  const config = defineKRV({});
  const defined = await openKRV({ ...config, path: ":memory:" });
  defined.close();
});

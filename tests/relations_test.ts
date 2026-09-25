import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  KrvConflictError,
  KrvReferenceError,
  KrvValidationError,
  openKRV,
  table,
} from "../src/main.ts";
import type { KrvTables } from "../src/main.ts";
import {
  fulfilled,
  openMemory,
  openShared,
  plain,
  rejected,
  settle,
  type TestDb,
} from "./_helpers.ts";

const collect = <T>(iterable: AsyncIterable<T>) => Array.fromAsync(iterable);

const count = async (iterable: AsyncIterable<unknown>) =>
  (await collect(iterable)).length;

const seed = async (db: TestDb) => {
  const alice = await db.insert(["accounts"], { name: "alice" });
  const bob = await db.insert(["accounts"], { name: "bob" });
  return { alice: alice.value, bob: bob.value };
};

// ---- Keys ----

Deno.test("keys: a key without placeholders is a static table", async () => {
  await using db = await openMemory();

  await db.set(["config"], { foo: "faa" });
  assertEquals(plain((await db.get(["config"])).value), { foo: "faa" });

  await db.set(["settings", "ui"], { theme: "dark" });
  assertEquals(plain((await db.get(["settings", "ui"])).value), {
    theme: "dark",
  });

  await assertRejects(
    // @ts-expect-error static tables have no id part
    () => db.get(["config", "x"]),
    Error,
    "No table for key",
  );
  await assertRejects(
    // @ts-expect-error not a valid theme
    () => db.set(["settings", "ui"], { theme: "blue" }),
    KrvValidationError,
  );
});

Deno.test("keys: {placeholder} fields get a ULID on insert", async () => {
  await using db = await openMemory();

  const first = await db.insert(["accounts"], { name: "a" });
  const second = await db.insert(["accounts"], { name: "b" });

  assertEquals(first.key, ["accounts", first.value.id]);
  assertEquals(first.value.id.length, 26);
  assert(first.value.id < second.value.id, "ids sort by insertion time");
  assertEquals((await db.get(first.key)).value, first.value);

  const names = (await collect(db.list(["accounts"]))).map((e) => e.name);
  assertEquals(names, ["a", "b"]);
});

Deno.test("keys: a {placeholder} field can be set explicitly", async () => {
  await using db = await openMemory();

  const custom = await db.insert(["accounts"], { id: "pagoru", name: "p" });
  assertEquals(custom.key, ["accounts", "pagoru"]);

  // set fills the id from the key.
  await db.set(["accounts", "other"], { name: "o" });
  assertEquals((await db.get(["accounts", "other"])).value?.id, "other");
});

Deno.test(
  "keys: creating with a key that doesn't match the value's id is rejected",
  async () => {
    await using db = await openMemory();
    await assertRejects(
      () => db.set(["accounts", "a"], { id: "b", name: "x" }),
      Error,
      "doesn't match the key fields",
    );
  },
);

Deno.test(
  'keys: an "id" field is generated once and kept on later sets',
  async () => {
    await using db = await openMemory();

    const { key, value } = await db.insert(["accounts"], { name: "a" });
    assertEquals(value.token.length, 26);

    await db.set(key, { name: "renamed" });
    assertEquals((await db.get(key)).value?.token, value.token);
  },
);

Deno.test("keys: nested keys with several placeholders", async () => {
  await using db = await openMemory();
  const { alice } = await seed(db);
  const org = await db.insert(["orgs"], { name: "acme" });

  const member = await db.insert(["orgs", "members"], {
    orgId: org.value.id,
    accountId: alice.id,
  });
  assertEquals(member.key, ["orgs", org.value.id, "members", member.value.id]);

  // The org itself is not listed as a member, and vice versa.
  assertEquals(await count(db.list(["orgs"])), 1);
  assertEquals(
    await count(
      db.list(["orgs", "members"], { where: { orgId: org.value.id } }),
    ),
    1,
  );
});

Deno.test("keys: invalid table definitions are rejected at open", async () => {
  const cases: [KrvTables, string][] = [
    [
      [
        table({ key: ["x", "{id}"], schema: { id: "{id}" } }),
        table({ key: ["{other}", "y"], schema: { other: "{other}" } }),
      ],
      "overlapping keys",
    ],
    [
      [table({ key: ["x", "{id}"], schema: { name: "string" } })],
      "has no schema field",
    ],
    [
      [table({ key: ["x", "{id}"], schema: { id: "{nope}" } })],
      "is not a placeholder",
    ],
    [
      [table({ key: ["x", "{id}"], schema: { id: "{id}", b: "{ghost.id}" } })],
      'referenced table "ghost" does not exist',
    ],
    [
      [
        table({ key: ["x", "{id}"], schema: { id: "{id}" } }),
        table({ key: ["y", "{id}"], schema: { id: "{id}", a: "{x.nope}" } }),
      ],
      "is not a key placeholder",
    ],
  ];

  for (const [tables, message] of cases) {
    await assertRejects(
      // Invalid on purpose: only the runtime check is under test here.
      () => openKRV({ path: ":memory:", tables: tables as never }),
      Error,
      message,
    );
  }
});

Deno.test(
  "keys: list throws at the call for an unknown table, before iterating",
  async () => {
    await using db = await openMemory();
    assertThrows(
      // @ts-expect-error no such table
      () => db.list(["nope"]),
      Error,
      "No table with key nope",
    );
  },
);

Deno.test(
  "list: await gives an array, for await streams, both reusable",
  async () => {
    await using db = await openMemory();
    await seed(db);

    const result = db.list(["accounts"]);

    const rows = await result;
    assert(Array.isArray(rows));
    assertEquals(
      rows.map((r) => r.name),
      ["alice", "bob"],
    );

    const streamed: string[] = [];
    for await (const row of result) streamed.push(row.name);
    assertEquals(streamed, ["alice", "bob"]);

    // Each use reads again, so it sees new rows.
    await db.insert(["accounts"], { name: "carol" });
    assertEquals((await result).length, 3);
  },
);

// ---- References ----

Deno.test("refs: a post can't reference a missing account", async () => {
  await using db = await openMemory();
  await assertRejects(
    () => db.insert(["posts"], { title: "x", accountId: "ghost" }),
    KrvReferenceError,
    "accounts/ghost does not exist",
  );
  assertEquals(await count(db.list(["posts"])), 0);
});

Deno.test(
  "refs: list where uses the index and follows reassignments",
  async () => {
    await using db = await openMemory();
    const { alice, bob } = await seed(db);

    const p1 = await db.insert(["posts"], { title: "p1", accountId: alice.id });
    await db.insert(["posts"], { title: "p2", accountId: alice.id });
    await db.insert(["posts"], { title: "p3", accountId: bob.id });

    const titlesOf = async (accountId: string) =>
      (await collect(db.list(["posts"], { where: { accountId } }))).map(
        (e) => e.title,
      );

    assertEquals(await titlesOf(alice.id), ["p1", "p2"]);
    assertEquals(await titlesOf(bob.id), ["p3"]);

    await db.set(p1.key, { title: "p1", accountId: bob.id });
    assertEquals(await titlesOf(alice.id), ["p2"]);
    assertEquals(await titlesOf(bob.id), ["p1", "p3"]);
  },
);

Deno.test("refs: where on a plain field, limit and reverse", async () => {
  await using db = await openMemory();
  const { alice } = await seed(db);
  for (const title of ["a", "b", "a", "c", "a"]) {
    await db.insert(["posts"], { title, accountId: alice.id });
  }

  assertEquals(await count(db.list(["posts"], { where: { title: "a" } })), 3);

  const limited = await collect(
    db.list(["posts"], {
      where: { accountId: alice.id },
      limit: 2,
      reverse: true,
    }),
  );
  assertEquals(
    limited.map((e) => e.title),
    ["a", "c"],
  );
});

Deno.test(
  "refs: referencing a two-placeholder key uses the row's other fields",
  async () => {
    await using db = await openMemory();
    const { alice } = await seed(db);
    const org = await db.insert(["orgs"], { name: "acme" });
    const other = await db.insert(["orgs"], { name: "other" });
    const member = await db.insert(["orgs", "members"], {
      orgId: org.value.id,
      accountId: alice.id,
    });

    await db.insert(["notes"], {
      orgId: org.value.id,
      memberId: member.value.id,
      text: "hi",
    });

    // Same member id, but in the wrong org: that member doesn't exist.
    await assertRejects(
      () =>
        db.insert(["notes"], {
          orgId: other.value.id,
          memberId: member.value.id,
          text: "x",
        }),
      KrvReferenceError,
      "does not exist",
    );

    const notes = await collect(
      db.list(["notes"], {
        where: { orgId: org.value.id, memberId: member.value.id },
      }),
    );
    assertEquals(
      notes.map((n) => n.text),
      ["hi"],
    );
  },
);

// ---- Delete: restrict / cascade ----

Deno.test(
  "delete: without cascade, a referenced row can't be deleted",
  async () => {
    await using db = await openMemory();
    const { alice } = await seed(db);
    const post = await db.insert(["posts"], {
      title: "p",
      accountId: alice.id,
    });

    await assertRejects(
      () => db.delete(["accounts", alice.id]),
      KrvReferenceError,
      "cascade: true",
    );
    assertEquals((await db.get(["accounts", alice.id])).value?.name, "alice");

    await db.delete(post.key);
    await db.delete(["accounts", alice.id]);
    assertEquals((await db.get(["accounts", alice.id])).value, null);
  },
);

Deno.test(
  "delete: cascade removes everything that references the row, recursively",
  async () => {
    await using db = await openMemory();
    const { alice, bob } = await seed(db);
    const post = await db.insert(["posts"], {
      title: "p",
      accountId: alice.id,
    });
    // Bob comments on Alice's post.
    await db.insert(["comments"], {
      text: "hi",
      postId: post.value.id,
      accountId: bob.id,
    });

    await db.delete(["accounts", alice.id], { cascade: true });

    assertEquals((await db.get(post.key)).value, null);
    assertEquals(await count(db.list(["comments"])), 0);
    assertEquals(
      await count(db.list(["posts"], { where: { accountId: alice.id } })),
      0,
    );
    // Bob is no longer referenced, so a plain delete works.
    await db.delete(["accounts", bob.id]);
  },
);

Deno.test(
  'delete: cascade "unset" clears optional references, deletes the rest',
  async () => {
    const db = await openKRV({
      path: ":memory:",
      tables: [
        table({
          key: ["accounts", "{accountId}"],
          schema: { id: "{accountId}", name: "string" },
        }),
        table({
          // Optional to the account, required to the post: deleted with it
          // (declared first, so it's queued to be unset before that).
          key: ["comments", "{commentId}"],
          schema: {
            id: "{commentId}",
            "accountId?": "{accounts.accountId}",
            postId: "{posts.postId}",
          },
        }),
        table({
          key: ["posts", "{postId}"],
          schema: { id: "{postId}", authorId: "{accounts.accountId}" },
        }),
        table({
          key: ["codes", "{codeId}"],
          schema: { id: "{codeId}", "accountId?": "{accounts.accountId}" },
          indexes: { byAccount: { fields: ["accountId"], unique: true } },
        }),
        table({
          key: ["gifts", "{giftId}"],
          schema: {
            id: "{giftId}",
            accountId: ["{accounts.accountId}", null],
          },
        }),
      ],
    });
    const alice = await db.insert(["accounts"], { name: "alice" });
    const accountId = alice.value.id;
    const post = await db.insert(["posts"], { authorId: accountId });
    const code = await db.insert(["codes"], { accountId });
    const gift = await db.insert(["gifts"], { accountId });
    const comment = await db.insert(["comments"], {
      accountId,
      postId: post.value.id,
    });

    await db.delete(alice.key, { cascade: "unset" });

    assertEquals((await db.get(post.key)).value, null);
    assertEquals((await db.get(comment.key)).value, null);

    const codeAfter = (await db.get(code.key)).value!;
    assert("accountId" in codeAfter);
    assertEquals(codeAfter.accountId, undefined);
    assert(codeAfter.updatedAt >= code.value.updatedAt);
    assertEquals((await db.get(gift.key)).value!.accountId, null);

    // Indexes and references follow: the account can come back, and its id
    // is free again in the unique index.
    const again = await db.insert(["accounts"], { id: accountId, name: "a" });
    assertEquals(await db.list(["codes"], { where: { accountId } }), []);
    await db.insert(["codes"], { accountId });
    await db.delete(again.key, { cascade: "unset" });
    db.close();
  },
);

Deno.test("delete: cascade through nested keys", async () => {
  await using db = await openMemory();
  const { alice } = await seed(db);
  const org = await db.insert(["orgs"], { name: "acme" });
  const member = await db.insert(["orgs", "members"], {
    orgId: org.value.id,
    accountId: alice.id,
  });
  await db.insert(["notes"], {
    orgId: org.value.id,
    memberId: member.value.id,
    text: "hi",
  });

  await db.delete(org.key, { cascade: true });

  assertEquals((await db.get(member.key)).value, null);
  assertEquals(await count(db.list(["notes"])), 0);
  assertEquals((await db.get(["accounts", alice.id])).value?.name, "alice");
});

// ---- Key changes ----

Deno.test(
  "move: changing the id moves the row and updates every reference",
  async () => {
    await using db = await openMemory();
    const { alice } = await seed(db);
    const post = await db.insert(["posts"], {
      title: "p",
      accountId: alice.id,
    });

    await db.set(["accounts", alice.id], { id: "alice", name: "alice" });

    assertEquals((await db.get(["accounts", alice.id])).value, null);
    assertEquals(
      (await db.get(["accounts", "alice"])).value?.token,
      alice.token,
    );
    assertEquals((await db.get(post.key)).value?.accountId, "alice");
    assertEquals(
      await count(db.list(["posts"], { where: { accountId: "alice" } })),
      1,
    );
    assertEquals(
      await count(db.list(["posts"], { where: { accountId: alice.id } })),
      0,
    );

    // The new key is protected by the moved references.
    await assertRejects(
      () => db.delete(["accounts", "alice"]),
      KrvReferenceError,
    );
  },
);

Deno.test("move: rows whose key contains the reference move too", async () => {
  await using db = await openMemory();
  const { alice } = await seed(db);
  const org = await db.insert(["orgs"], { name: "acme" });
  const member = await db.insert(["orgs", "members"], {
    orgId: org.value.id,
    accountId: alice.id,
  });
  const note = await db.insert(["notes"], {
    orgId: org.value.id,
    memberId: member.value.id,
    text: "hi",
  });

  await db.set(org.key, { id: "acme", name: "acme" });

  // The member's key includes the org id, so it moved...
  assertEquals((await db.get(member.key)).value, null);
  const moved = await db.get(["orgs", "acme", "members", member.value.id]);
  assertEquals(moved.value?.orgId, "acme");
  // ...and the note that references the member followed it.
  assertEquals((await db.get(note.key)).value?.orgId, "acme");
  assertEquals(
    await count(
      db.list(["notes"], {
        where: { orgId: "acme", memberId: member.value.id },
      }),
    ),
    1,
  );
});

Deno.test("move: can't move onto an existing key", async () => {
  await using db = await openMemory();
  const { alice, bob } = await seed(db);
  await assertRejects(
    () => db.set(["accounts", alice.id], { id: bob.id, name: "x" }),
    KrvConflictError,
  );
  assertEquals((await db.get(["accounts", alice.id])).value?.name, "alice");
});

// ---- Races ----

Deno.test(
  "race: cascade delete vs concurrent inserts leaves no orphans",
  async () => {
    for (let round = 0; round < 20; round++) {
      await using db = await openMemory();
      const { alice } = await seed(db);
      const insert = () =>
        db.insert(["posts"], { title: "p", accountId: alice.id });

      const results = await settle<unknown>([
        ...Array.from({ length: 10 }, insert),
        db.delete(["accounts", alice.id], { cascade: true }),
        ...Array.from({ length: 10 }, insert),
      ]);

      for (const { reason } of rejected(results)) {
        assert(reason instanceof KrvReferenceError, `unexpected: ${reason}`);
      }
      assertEquals((await db.get(["accounts", alice.id])).value, null);
      assertEquals(
        await count(db.list(["posts"])),
        0,
        `orphans in round ${round}`,
      );
    }
  },
);

Deno.test(
  "race: restrict delete vs concurrent insert never leaves a dangling reference",
  async () => {
    for (let round = 0; round < 20; round++) {
      await using db = await openMemory();
      const { alice } = await seed(db);

      const [insert, remove] = await settle<unknown>([
        db.insert(["posts"], { title: "p", accountId: alice.id }),
        db.delete(["accounts", alice.id]),
      ]);

      const accountExists =
        (await db.get(["accounts", alice.id])).value !== null;
      const posts = await count(
        db.list(["posts"], { where: { accountId: alice.id } }),
      );

      if (insert.status === "fulfilled") {
        assert(accountExists && posts === 1);
        assert(
          remove.status === "rejected" &&
            remove.reason instanceof KrvReferenceError,
        );
      } else {
        assert(!accountExists && posts === 0);
        assert(remove.status === "fulfilled");
      }
    }
  },
);

Deno.test(
  "race: move vs concurrent insert, a new post always follows the account",
  async () => {
    for (let round = 0; round < 20; round++) {
      await using db = await openMemory();
      const { alice } = await seed(db);

      const [, insert] = await settle<unknown>([
        db.set(["accounts", alice.id], { id: "alice", name: "alice" }),
        db.insert(["posts"], { title: "p", accountId: alice.id }),
      ]);

      // Either the insert landed first and was moved along, or it found the old key gone.
      const posts = await collect(db.list(["posts"]));
      if (insert.status === "fulfilled") {
        assertEquals(
          posts.map((p) => p.accountId),
          ["alice"],
        );
      } else {
        assert(insert.reason instanceof KrvReferenceError, `${insert.reason}`);
        assertEquals(posts.length, 0);
      }
      assertEquals(
        await count(db.list(["posts"], { where: { accountId: alice.id } })),
        0,
      );
    }
  },
);

Deno.test("race: concurrent reassignments keep the index in sync", async () => {
  await using db = await openMemory();
  const accounts = await Promise.all(
    ["a", "b", "c"].map((name) => db.insert(["accounts"], { name })),
  );
  const post = await db.insert(["posts"], {
    title: "p",
    accountId: accounts[0].value.id,
  });

  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      db.set(post.key, { title: "p", accountId: accounts[i % 3].value.id }),
    ),
  );

  const final = (await db.get(post.key)).value!.accountId;
  for (const { value } of accounts) {
    const listed = await count(
      db.list(["posts"], { where: { accountId: value.id } }),
    );
    assertEquals(listed, value.id === final ? 1 : 0);
  }
});

Deno.test(
  "race: two connections, cascade delete vs inserts leaves no orphans",
  async () => {
    await using shared = await openShared();
    const { a, b } = shared;
    const alice = await a.insert(["accounts"], { name: "alice" });

    const results = await settle<unknown>([
      ...Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).insert(["posts"], {
          title: "p",
          accountId: alice.value.id,
        }),
      ),
      b.delete(alice.key, { cascade: true }),
    ]);

    assert(fulfilled(results).length >= 1);
    for (const { reason } of rejected(results)) {
      assert(reason instanceof KrvReferenceError, `unexpected: ${reason}`);
    }
    assertEquals(await count(a.list(["posts"])), 0);
  },
);

// ---- Table names ----

Deno.test("names: tables are named by their key's literal parts", async () => {
  const db = await openKRV({
    path: ":memory:",
    tables: [
      {
        key: ["users", "{userId}"],
        schema: { id: "{userId}", username: "string" },
      },
      {
        key: ["posts", "posts1", "{postId}"],
        schema: { id: "{postId}", userId: "{users.userId}", title: "string" },
      },
      {
        key: ["posts", "posts1", "{postId}", "likes", "{likeId}"],
        schema: {
          postId: "{posts.posts1.postId}",
          id: "{likeId}",
          userId: "{users.userId}",
        },
      },
    ],
  });

  const user = await db.insert(["users"], { username: "pagoru" });
  const post = await db.insert(["posts", "posts1"], {
    userId: user.value.id,
    title: "hi",
  });
  await db.insert(["posts", "posts1", "likes"], {
    postId: post.value.id,
    userId: user.value.id,
  });

  await assertRejects(
    () => db.insert(["posts", "posts1"], { userId: "ghost", title: "x" }),
    KrvReferenceError,
    "users/ghost does not exist",
  );
  await assertRejects(() => db.delete(post.key), KrvReferenceError);
  await db.delete(user.key, { cascade: true });
  assertEquals(await count(db.list(["posts", "posts1", "likes"])), 0);
  db.close();
});

Deno.test(
  "names: two tables can't share a name, and a key needs a literal part",
  async () => {
    const cases: [KrvTables, string][] = [
      [
        [
          table({ key: ["a", "{id}"], schema: { id: "{id}" } }),
          table({
            key: ["a", "{id}", "{other}"],
            schema: { id: "{id}", other: "{other}" },
          }),
        ],
        'Two tables are named "a"',
      ],
      [
        [table({ key: ["{id}"], schema: { id: "{id}" } })],
        "needs at least one literal part",
      ],
      [
        [
          table({ key: ["a", "{id}"], schema: { id: "{id}", b: "{b.id}" } }),
          table({ key: ["b", "c", "{id}"], schema: { id: "{id}" } }),
        ],
        'referenced table "b" does not exist',
      ],
    ];
    for (const [tables, message] of cases) {
      await assertRejects(
        () => openKRV({ path: ":memory:", tables: tables as never }),
        Error,
        message,
      );
    }
  },
);

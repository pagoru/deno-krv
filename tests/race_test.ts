import { assert, assertEquals, assertRejects } from "@std/assert";
import { KrvValidationError } from "../src/main.ts";
import {
  fulfilled,
  increment,
  isConflict,
  openMemory,
  openShared,
  plain,
  rejected,
  settle,
} from "./_helpers.ts";

Deno.test(
  "race: create-if-absent, exactly one of N concurrent creates wins",
  async () => {
    await using db = await openMemory();

    const results = await settle(
      Array.from({ length: 50 }, (_, i) =>
        db.set(
          ["users", "alice"],
          { name: `writer-${i}` },
          { check: null, values: false },
        ),
      ),
    );

    assertEquals(fulfilled(results).length, 1);
    assert(rejected(results).every((r) => isConflict(r.reason)));

    // The stored value belongs to the single winner.
    const stored = await db.get(["users", "alice"], { values: false });
    assertEquals(stored.versionstamp, fulfilled(results)[0].value.versionstamp);
  },
);

Deno.test(
  "race: two writers holding the same versionstamp, only the first commits",
  async () => {
    await using db = await openMemory();
    await db.set(["users", "1"], { name: "Pablo", age: 20 });

    // Both "clients" read the same snapshot before either writes.
    const readA = await db.get(["users", "1"], { values: false });
    const readB = await db.get(["users", "1"], { values: false });
    assertEquals(readA.versionstamp, readB.versionstamp);

    await db.set(
      ["users", "1"],
      { name: "Pablo", age: 21 },
      {
        check: readA.versionstamp,
      },
    );

    await assertRejects(
      () =>
        db.set(
          ["users", "1"],
          { name: "Pablo", age: 99 },
          {
            check: readB.versionstamp,
          },
        ),
      Error,
      "check failed",
    );

    // B's write never landed.
    assertEquals(plain(await db.get(["users", "1"])), {
      id: "1",
      name: "Pablo",
      age: 21,
    });
  },
);

Deno.test(
  "race: without a check, the last write silently wins (lost update)",
  async () => {
    await using db = await openMemory();
    await db.set(["counters", "c"], { value: 0 });

    const readA = await db.get(["counters", "c"], { values: false });
    const readB = await db.get(["counters", "c"], { values: false });

    await db.set(["counters", "c"], { value: readA.value!.value + 1 });
    await db.set(["counters", "c"], { value: readB.value!.value + 1 });

    // Two increments, but the counter only moved by one: that's what `check` prevents.
    assertEquals(plain(await db.get(["counters", "c"])), {
      name: "c",
      value: 1,
    });
  },
);

Deno.test(
  "race: concurrent increments with check + retry never lose an update",
  async () => {
    await using db = await openMemory();

    const n = 100;
    const attempts = await Promise.all(
      Array.from({ length: n }, () => increment(db, "hits")),
    );

    assertEquals((await db.get(["counters", "hits"]))?.value, n);
    // Sanity check that the race actually happened: some writers had to retry.
    assert(
      attempts.some((a) => a > 0),
      "expected at least one conflict",
    );
  },
);

Deno.test(
  "race: concurrent writes to different keys do not conflict",
  async () => {
    await using db = await openMemory();

    const results = await settle(
      Array.from({ length: 100 }, (_, i) =>
        db.set(["users", `${i}`], { name: `user-${i}` }, { check: null }),
      ),
    );

    assertEquals(rejected(results).length, 0);
    for (let i = 0; i < 100; i++) {
      assertEquals(plain(await db.get(["users", `${i}`])), {
        id: `${i}`,
        name: `user-${i}`,
      });
    }
  },
);

Deno.test(
  "race: a failed check leaves the stored value untouched",
  async () => {
    await using db = await openMemory();

    const first = await db.set(
      ["users", "1"],
      { name: "original" },
      { values: false },
    );
    await db.set(["users", "1"], { name: "changed" });

    await assertRejects(
      () =>
        db.set(
          ["users", "1"],
          { name: "stale" },
          { check: first.versionstamp },
        ),
      Error,
      "check failed",
    );

    assertEquals((await db.get(["users", "1"]))?.name, "changed");
  },
);

Deno.test(
  "race: an invalid value racing a valid one never gets written",
  async () => {
    await using db = await openMemory();

    const results = await settle([
      // deno-lint-ignore no-explicit-any
      db.set(["users", "1"], { name: 123 } as any, { check: null }),
      db.set(["users", "1"], { name: "valid" }, { check: null }),
      // deno-lint-ignore no-explicit-any
      db.set(["users", "1"], { name: "x", extra: true } as any, {
        check: null,
      }),
    ]);

    const [first, second] = rejected(results);
    assert(first.reason instanceof KrvValidationError);
    assert(second.reason instanceof KrvValidationError);
    assertEquals(fulfilled(results).length, 1);
    assertEquals((await db.get(["users", "1"]))?.name, "valid");
  },
);

Deno.test(
  "race: two connections to one file, create-if-absent has one winner",
  async () => {
    await using shared = await openShared();
    const { a, b } = shared;

    const results = await settle(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? a : b).set(
          ["users", "bob"],
          { name: `conn-${i % 2}` },
          {
            check: null,
          },
        ),
      ),
    );

    assertEquals(fulfilled(results).length, 1);
    // Losers must fail as conflicts, not with infrastructure errors like "database is locked".
    for (const { reason } of rejected(results)) {
      assert(isConflict(reason), `unexpected rejection: ${reason}`);
    }

    // Both connections agree on the result.
    const [fromA, fromB] = await Promise.all([
      a.get(["users", "bob"], { values: false }),
      b.get(["users", "bob"], { values: false }),
    ]);
    assertEquals(fromA.versionstamp, fromB.versionstamp);
    assertEquals(fromA.value, fromB.value);
  },
);

Deno.test(
  "race: two connections to one file, interleaved increments stay exact",
  async () => {
    await using shared = await openShared();
    const { a, b } = shared;

    const n = 50;
    await Promise.all(
      Array.from({ length: n }, (_, i) => increment(i % 2 ? a : b, "shared")),
    );

    assertEquals((await a.get(["counters", "shared"]))?.value, n);
    assertEquals((await b.get(["counters", "shared"]))?.value, n);
  },
);

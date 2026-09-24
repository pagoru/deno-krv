import { KrvConflictError, openKRV, table } from "../src/main.ts";

/** Tables shared by every test file. Add new ones here as tests need them. */
export const tables = [
  table({
    key: ["counters", "{name}"],
    schema: { name: "{name}", value: "number" },
  }),
  table({
    key: ["users", "{userId}"],
    schema: { id: "{userId}", name: "string", "age?": "number" },
  }),
  table({ key: ["config"], schema: { foo: "string" } }),
  table({
    key: ["settings", "ui"],
    schema: { theme: ["|light|", "|dark|"] },
  }),
  table({
    key: ["accounts", "{accountId}"],
    schema: { id: "{accountId}", name: "string", token: "id" },
  }),
  table({
    key: ["posts", "{postId}"],
    schema: {
      id: "{postId}",
      title: "string",
      accountId: "{accounts.accountId}",
    },
  }),
  table({
    key: ["comments", "{commentId}"],
    schema: {
      id: "{commentId}",
      text: "string",
      postId: "{posts.postId}",
      accountId: "{accounts.accountId}",
    },
  }),
  table({
    key: ["orgs", "{orgId}"],
    schema: { id: "{orgId}", name: "string" },
  }),
  // Nested key: the org id is both a key part and a reference.
  table({
    key: ["orgs", "{orgId}", "members", "{memberId}"],
    schema: {
      orgId: "{orgs.orgId}",
      id: "{memberId}",
      accountId: "{accounts.accountId}",
    },
  }),
  // References a table with a two-placeholder key: orgId comes along.
  table({
    key: ["notes", "{noteId}"],
    schema: {
      id: "{noteId}",
      orgId: "{orgs.orgId}",
      memberId: "{orgs.members.memberId}",
      text: "string",
    },
  }),
];

export type TestDb = Awaited<ReturnType<typeof openMemory>>;

/** Fresh in-memory database; disposed automatically with `await using`. */
export const openMemory = async () => {
  const db = await openKRV({ path: ":memory:", tables });
  return Object.assign(db, {
    [Symbol.asyncDispose]: () => Promise.resolve(db.close()),
  });
};

/** Two independent connections to the same on-disk database. */
export const openShared = async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/shared.db`;
  const a = await openKRV({ path, tables });
  const b = await openKRV({ path, tables });
  return {
    a,
    b,
    [Symbol.asyncDispose]: async () => {
      a.close();
      b.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
};

export const settle = <T>(promises: Promise<T>[]) =>
  Promise.allSettled(promises);

export const fulfilled = <T>(results: PromiseSettledResult<T>[]) =>
  results.filter(
    (r): r is PromiseFulfilledResult<T> => r.status === "fulfilled",
  );

export const rejected = <T>(results: PromiseSettledResult<T>[]) =>
  results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

/** True when `error` is a failed versionstamp check (a real conflict). */
export const isConflict = (error: unknown) => error instanceof KrvConflictError;

/** Read → modify → write with a versionstamp check, retrying on conflict. */
export const increment = async (
  db: Pick<TestDb, "get" | "set">,
  id: string,
  maxRetries = 1_000,
): Promise<number> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const current = await db.get(["counters", id]);
    const next = (current.value?.value ?? 0) + 1;
    try {
      await db.set(
        ["counters", id],
        { value: next },
        {
          check: current.versionstamp,
        },
      );
      return attempt;
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
  throw new Error(`increment gave up after ${maxRetries + 1} attempts`);
};

/** A row without its automatic timestamps, for exact comparisons. */
export const plain = <T extends { createdAt?: number; updatedAt?: number }>(
  row: T | null,
) => {
  if (!row) return row;
  const { createdAt: _created, updatedAt: _updated, ...rest } = row;
  return rest;
};

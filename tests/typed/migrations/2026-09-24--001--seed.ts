import type { KrvMigration } from "../../../src/main.ts";
import type { Db } from "../config.ts";

export default {
  url: import.meta.url,
  up: async (db) => {
    const { value } = await db.insert(["users"], {
      username: "ana",
      email: "ana@x.dev",
    });
    const username: string = value.username;
    await db.raw.set(["seeded"], username);

    // Only type-checked: each is a compile error.
    if (Math.random() > 2) {
      // @ts-expect-error unknown field
      await db.insert(["users"], { username: "a", email: "a@x", nope: 1 });
      // @ts-expect-error wrong type
      await db.insert(["users"], { username: 1, email: "a@x" });
      // @ts-expect-error unknown table
      await db.insert(["nope"], {});
    }
  },
} satisfies KrvMigration<Db>;

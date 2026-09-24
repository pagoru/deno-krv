import type { KrvMigration } from "@da/deno-krv";
import type { Db } from "../config.ts";

export default {
  url: import.meta.url, // the file name identifies the migration
  up: async (db) => {
    await db.insert(["users"], {
      username: "pagoru",
      email: "asdd",
    });
  },
} satisfies KrvMigration<Db>;

import { openKRV } from "@da/deno-krv";
import { config } from "./config.ts";

const db = await openKRV({
  ...config,
  path: ":memory:",
  path: "db",
  migrations: [
    await import("./migrations/2026-09-24--001--first-migration.ts"),
  ],
  events: {
    beforeMigration: ({ migration }) => {
      console.log(`before: ${migration.id} ${migration.name}`);
    },
    afterMigration: ({ migration }) => {
      console.log(`after: ${migration.id} ${migration.name}`);
    },
  },
});

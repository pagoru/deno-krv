import { assertEquals } from "@std/assert";
import { openKRV } from "../src/main.ts";
import { config, type Db } from "./typed/config.ts";

Deno.test(
  "defineKRV: migrations get the typed database; openKRV keeps its types",
  async () => {
    const db = await openKRV({
      ...config,
      path: ":memory:",
      migrations: [import("./typed/migrations/2026-09-24--001--seed.ts")],
    });
    const typed: Db = db; // the same type as KrvDatabaseOf<typeof config>
    const [user] = await typed.list(["users"]);
    const username: string = user.username;
    assertEquals(username, "ana");
    assertEquals(user.email, "ana@x.dev"); // "&": read back decrypted
    db.close();
  },
);

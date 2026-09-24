import { defineKRV, type KrvDatabaseOf, table } from "../../src/main.ts";

/** Schema declared apart from `openKRV`, so migrations can use its type. */
export const config = defineKRV({
  validators: { email: ["string", (v) => v.includes("@")] },
  tables: [
    table({
      key: ["users", "{userId}"],
      schema: {
        id: "{userId}",
        username: "string",
        "email&": "email",
        "password*?": "string",
      },
    }),
  ],
});

export type Db = KrvDatabaseOf<typeof config>;

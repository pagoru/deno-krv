import { defineKRV, type KrvDatabaseOf } from "@da/deno-krv";

export const config = defineKRV({
  tables: [
    {
      key: ["users", "{userId}"],
      schema: {
        id: "{userId}",
        username: "string",
        "email&": "string",
        "password*?": "string",
      },
      indexes: {
        byUsername: { unique: true, fields: ["username"] },
        byEmail: { unique: true, fields: ["email"], using: "#" },
      },
    },
    {
      key: ["posts", "{postId}", "{lang}"],
      schema: {
        id: "{postId}",
        lang: "{lang}",
        userId: "{users.userId}",
        title: "string",
        "visible?": "boolean",
      },
    },
  ],
  validators: {},
});

export type Db = KrvDatabaseOf<typeof config>;

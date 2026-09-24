import { openKRV } from "../src/main.ts";

const db = await openKRV({
  path: ":memory:",
  tables: [
    {
      key: ["users", "{userId}"],
      schema: {
        id: "{userId}",
        username: "string",
      },
      indexes: {
        byUsername: { unique: true, fields: ["username"] },
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

const {
  value: { id: userId },
} = await db.insert(["users"], { username: "pagoru" });
await db.insert(["users"], { username: "pagoru1" });

await db.insert(["posts"], {
  title: "This is a title",
  userId,
  lang: 'en'
});
await db.insert(["posts"], {
  id: "test",
  visible: true,
  title: "This is a title 2",
  userId,
});
console.log(await db.list(["posts"], { expand: { user: "userId" }, values: false }));
// console.log(
//   await db.list(["users"], {
//     expand: {
//       posts: {
//         from: "posts.userId",
//         where: { visible: true },
//       },
//     },
//   }),
// );

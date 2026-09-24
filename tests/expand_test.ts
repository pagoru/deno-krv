import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openKRV } from "../src/main.ts";

const open = () =>
  openKRV({
    path: ":memory:",
    tables: [
      {
        key: ["authors", "{authorId}"],
        schema: { id: "{authorId}", name: "string" },
      },
      {
        key: ["books", "{bookId}"],
        schema: {
          id: "{bookId}",
          authorId: "{authors.authorId}",
          "editorId?": "{authors.authorId}",
          title: "string",
          published: "boolean",
        },
      },
      {
        key: ["reviews", "{reviewId}"],
        schema: { id: "{reviewId}", bookId: "{books.bookId}", stars: "number" },
      },
      // 1:1 with authors: keyed by the reference itself.
      {
        key: ["profiles", "{authorId}"],
        schema: { authorId: "{authors.authorId}", bio: "string" },
      },
      // A table whose name has a dot.
      {
        key: ["posts", "drafts", "{draftId}"],
        schema: {
          id: "{draftId}",
          authorId: "{authors.authorId}",
          text: "string",
        },
      },
    ],
  });

const seed = async () => {
  const db = await open();
  const le = await db.insert(["authors"], { name: "Le Guin" });
  const herbert = await db.insert(["authors"], { name: "Herbert" });
  const dispossessed = await db.insert(["books"], {
    authorId: le.value.id,
    editorId: herbert.value.id,
    title: "The Dispossessed",
    published: true,
  });
  const draft = await db.insert(["books"], {
    authorId: le.value.id,
    title: "Draft",
    published: false,
  });
  await db.insert(["books"], {
    authorId: herbert.value.id,
    title: "Dune",
    published: true,
  });
  await db.insert(["reviews"], { bookId: dispossessed.value.id, stars: 5 });
  await db.insert(["reviews"], { bookId: dispossessed.value.id, stars: 4 });
  await db.insert(["profiles"], { authorId: le.value.id, bio: "Earthsea" });
  await db.insert(["posts", "drafts"], {
    authorId: le.value.id,
    text: "notes",
  });
  return { db, le, herbert, dispossessed, draft };
};

Deno.test(
  "expand: forward, a reference field becomes the row it points to",
  async () => {
    const { db, dispossessed, draft } = await seed();

    const book = (
      await db.get(dispossessed.key, {
        expand: { author: "authorId", editor: "editorId" },
      })
    ).value!;
    const name: string = book.author.name;
    assertEquals(name, "Le Guin");
    assertEquals(book.editor?.name, "Herbert");
    assertEquals(book.authorId, book.author.id); // the id stays

    // An empty optional reference expands to null.
    const noEditor = (
      await db.get(draft.key, { expand: { editor: "editorId" } })
    ).value!;
    assertEquals(noEditor.editor, null);
    db.close();
  },
);

Deno.test(
  "expand: reverse, rows of another table pointing here become a list",
  async () => {
    const { db, le } = await seed();

    const author = (
      await db.get(le.key, {
        expand: { books: "books.authorId", drafts: "posts.drafts.authorId" },
      })
    ).value!;
    const titles: string[] = author.books.map((b) => b.title);
    assertEquals(titles, ["The Dispossessed", "Draft"]);
    assertEquals(
      author.drafts.map((d) => d.text),
      ["notes"],
    );
    db.close();
  },
);

Deno.test(
  "expand: a table keyed by the reference (1:1) gives one row or null",
  async () => {
    const { db, le, herbert } = await seed();

    const withProfile = (
      await db.get(le.key, {
        expand: { profile: "profiles.authorId" },
      })
    ).value!;
    const bio: string | undefined = withProfile.profile?.bio;
    assertEquals(bio, "Earthsea");

    const without = (
      await db.get(herbert.key, {
        expand: { profile: "profiles.authorId" },
      })
    ).value!;
    assertEquals(without.profile, null);
    db.close();
  },
);

Deno.test("expand: options per reverse expand, and nesting", async () => {
  const { db } = await seed();

  const authors = await db.list(["authors"], {
    expand: {
      books: {
        from: "books.authorId",
        where: { published: true },
        filter: (b) => b.title.length > 3,
        limit: 1,
        expand: {
          reviews: { from: "reviews.bookId", reverse: true },
          author: "authorId",
        },
      },
    },
  });

  const le = authors.find((a) => a.name === "Le Guin")!;
  assertEquals(
    le.books.map((b) => b.title),
    ["The Dispossessed"],
  );
  const stars: number[] = le.books[0].reviews.map((r) => r.stars);
  assertEquals(stars, [4, 5]); // reversed
  assertEquals(le.books[0].author.name, "Le Guin");
  db.close();
});

Deno.test("expand: with list, find and values: false", async () => {
  const { db } = await seed();

  const books = await db.list(["books"], { expand: { author: "authorId" } });
  assertEquals(
    books.map((b) => b.author.name),
    ["Le Guin", "Le Guin", "Herbert"],
  );

  const dune = await db.find(["books"], {
    where: { title: "Dune" },
    expand: { author: "authorId" },
  });
  assertEquals(dune?.author.name, "Herbert");

  const [entry] = await db.list(["books"], {
    values: false,
    limit: 1,
    expand: { author: "authorId" },
  });
  assertEquals(entry.value.author.name, "Le Guin");

  let streamed = 0;
  for await (const book of db.list(["books"], {
    expand: { reviews: "reviews.bookId" },
  }))
    streamed += book.reviews.length;
  assertEquals(streamed, 2);
  db.close();
});

Deno.test(
  "expand: invalid expands fail at the call, and at compile time",
  async () => {
    const db = await open();

    assertThrows(
      // @ts-expect-error "title" isn't a reference field
      () => db.list(["books"], { expand: { x: "title" } }),
      Error,
      "isn't a reference field",
    );
    assertThrows(
      // @ts-expect-error clashes with the "title" field
      () => db.list(["books"], { expand: { title: "authorId" } }),
      Error,
      "already a field",
    );
    assertThrows(
      // @ts-expect-error reviews don't reference authors
      () => db.list(["authors"], { expand: { x: "reviews.bookId" } }),
      Error,
      "isn't a field of another table referencing authors",
    );
    await assertRejects(
      () =>
        db.find(["authors"], {
          // @ts-expect-error nested: "title" isn't a reference field of books
          expand: { b: { from: "books.authorId", expand: { x: "title" } } },
        }),
      Error,
      "isn't a reference field",
    );
    db.close();
  },
);

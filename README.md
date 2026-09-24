# deno-krv

**KRV** stands for **Key · Relation · Value**: [Deno KV](https://docs.deno.com/deploy/kv/)'s
key-value store, with relations between the values. A typed, schema-validated
layer where tables reference each other, and every write keeps those
relations consistent.

- Schemas are plain data. Types are inferred from them and every write is
  validated.
- Relations, indexes, transforms (hash/encrypt), timestamps and migrations.
- Every write, with its indexes and relations, commits atomically.

```ts
import { openKRV } from "./mod.ts";

const db = await openKRV({
  path: "./notes.db",
  tables: [
    {
      key: ["notes", "{noteId}"],
      schema: { id: "{noteId}", text: "string", done: "boolean" },
    },
  ],
});

const note = await db.insert(["notes"], { text: "Buy milk", done: false });
await db.update(note.key, { done: true });
const notes = await db.list(["notes"], { where: { done: true } });
await db.delete(note.key);
```

---

## Contents

- [Setup](#setup)
- [Tables and keys](#tables-and-keys)
- [Schema syntax](#schema-syntax)
- [Custom validators](#custom-validators)
- [Transforms](#transforms)
- [Indexes](#indexes)
- [Timestamps](#timestamps)
- [Relations](#relations)
- [Expanding relations](#expanding-relations)
- [Updating](#updating)
- [Reading: `where` and `filter`](#reading-where-and-filter)
- [Migrations](#migrations)
- [Schema changes](#schema-changes)
- [API reference](#api-reference)
- [Errors](#errors)
- [Guarantees and limits](#guarantees-and-limits)

---

## Setup

Enable Deno KV in `deno.json`:

```json
{ "unstable": ["kv"] }
```

TypeScript `strict` mode must be on (Deno's default). If you have a
`tsconfig.json`, set `"strict": true`.

A database file needs `--allow-read` and `--allow-write` for its folder.

---

## Tables and keys

A key mixes **literal parts** and **`{placeholders}`**, filled from the row.
Without placeholders, the table holds a single value.

```ts
tables: [
  { key: ["settings"], schema: { theme: "string" } },
  {
    key: ["notes", "{noteId}"],
    schema: { id: "{noteId}", text: "string" },
  },
]
```

```ts
await db.set(["settings"], { theme: "dark" });

const note = await db.insert(["notes"], { text: "Hi" }); // id generated
note.key; // ["notes", "01J…"]

await db.set(["notes", "welcome"], { text: "Hello" }); // id from the key
```

A table is **named by its key's literal parts**: `["notes", "{noteId}"]` is
`notes`, `["posts", "drafts", "{postId}"]` is `posts.drafts`. The name is used
by `insert(["posts", "drafts"], …)`, `list`, references
(`"{posts.drafts.postId}"`) and error messages. Two tables can't share one.

**Defining tables elsewhere**: written inline in `openKRV`, tables are plain
objects. In a separate variable, wrap them in `table()` (or add `as const`) so
their exact types are kept:

```ts
import { openKRV, table } from "./mod.ts";

export const notes = table({
  key: ["notes", "{noteId}"],
  schema: { id: "{noteId}", text: "string" },
});

const db = await openKRV({ tables: [notes] });
```

---

## Schema syntax

A schema maps field names to types. Modifiers go on the **name**:
`?` optional, `[]` array, `{}` map.

```ts
{
  key: ["products", "{sku}"],
  schema: {
    sku: "{sku}",
    name: "string",
    price: "number",
    "discount?": "number",
    "tags[]": "string",
    "stock{}": "number",               // Record<string, number>
    size: ["|S|", "|M|", "|L|"],        // "S" | "M" | "L"
    rating: [1, 2, 3, 4, 5],
    barcode: ["string", null],
    dimensions: { width: "number", "height?": "number" },
    "photos[]": { url: "string" },
  },
},
```

| Field name   | Type                  |
| ------------ | --------------------- |
| `name`       | `T`                   |
| `"name?"`    | optional `T`          |
| `"name[]"`   | `T[]`                 |
| `"name{}"`   | `Record<string, T>`   |
| `"name[]?"`  | optional `T[]`        |
| `"name{}[]"` | `Record<string, T>[]` |

| Type                                                  | Meaning                                       |
| ----------------------------------------------------- | --------------------------------------------- |
| `"string"` `"number"` `"boolean"` `"bigint"` `"date"` | Built-in types                                |
| `"unknown"`                                           | Anything (optional)                           |
| `"id"`                                                | String, a ULID when left empty                |
| `"\|text\|"`                                          | String literal                                |
| `1`, `true`, `null`, `undefined`                      | Raw literals                                  |
| `[a, b]`                                              | Union (`[x, undefined]` makes it optional)    |
| `{ … }`                                               | Nested object; unknown fields are rejected    |
| `"{placeholder}"`                                     | Key field                                     |
| `"{table.placeholder}"`                               | Reference to another table                    |

---

## Custom validators

Declare them once, use them by name. The base type is checked first, so the
function gets a typed value.

```ts
const db = await openKRV({
  validators: {
    email: ["string", (v) => v.includes("@")],
    "len(min, max)": [
      "string",
      (s, { min, max }: { min: number; max: number }) =>
        s.length >= min && s.length <= max,
    ],
  },
  tables: [
    {
      key: ["contacts", "{contactId}"],
      schema: { id: "{contactId}", name: "len(1, 40)", "emails[]": "email" },
    },
  ],
});
```

Arguments are numbers, `|text|`, `true`, `false` or `null`. Typos
(`"emial"`) and wrong arguments (`"len(3)"`) are compile errors.

---

## Transforms

A character after a field name stores something else than the plain value,
using your own functions:

```ts
const db = await openKRV({
  transforms: {
    "*": { save: (v) => bcrypt.hash(v), compare: (p, s) => bcrypt.compare(p, s) },
    "#": { save: (v) => sha256(v), deterministic: true },
    "&": { save: (v) => encrypt(v), load: (v) => decrypt(v) },
  },
  tables: [
    {
      key: ["members", "{memberId}"],
      schema: {
        id: "{memberId}",
        "pin*": "string", // hashed, check with db.compare
        "nickname#": "string", // hashed, searchable
        "phone&": "string", // encrypted, read back decrypted
      },
      indexes: {
        byPhone: { fields: ["phone"], using: "#", unique: true }, // see below
      },
    },
  ],
});

const m = await db.insert(["members"], {
  pin: "1234",
  nickname: "ana",
  phone: "+34600000000",
});

m.value.phone; // "+34600000000" (decrypted)
await db.compare(m.key, "pin", "1234"); // true
await db.list(["members"], { where: { nickname: "ana" } }); // hashed, then compared
await db.list(["members"], { where: { phone: "+34600000000" } }); // via byPhone
```

| Function                 | Meaning                                      |
| ------------------------ | -------------------------------------------- |
| `save`                   | What gets stored (required)                  |
| `load`                   | Restores the value on read                   |
| `compare(plain, stored)` | Used by `db.compare`                         |
| `deterministic`          | Same input, same output: searchable/indexable |

Validation runs on the plain value. Transforms work on top-level fields, and
on each item of `[]`/`{}`.

**Searching an encrypted field**: an encrypted value (`&`) is different every
time, so it can't be compared as stored. Give it an index `using` a
deterministic transform: the index is keyed by the hash of the plain value, and
`where: { phone }` hashes the searched value the same way. The row only holds
the encrypted phone. Without such an index, searching it is a compile error.
Use a keyed hash (e.g. HMAC with a secret) for this, since a plain hash of a
phone number can be guessed.

---

## Indexes

```ts
{
  key: ["books", "{bookId}"],
  schema: { id: "{bookId}", isbn: "string", genre: "string", year: "number" },
  indexes: {
    byIsbn: { fields: ["isbn"], unique: true },
    byGenreYear: { fields: ["genre", "year"] },
  },
},
```

```ts
await db.list(["books"], { where: { isbn: "978-0" } }); // unique index
await db.list(["books"], { where: { genre: "sci-fi", year: 1965 } }); // index

await db.insert(["books"], { isbn: "978-0", genre: "x", year: 1 });
// KrvConflictError: books.byIsbn: isbn already taken … (unique)
```

`where` uses an index when all its fields are present. Empty values aren't
indexed, so an optional unique field can be missing on many rows.

`using` indexes a field through a deterministic transform, for fields stored
encrypted: `using: "#"` for all fields, or `using: { phone: "#" }` for some
(see [Transforms](#transforms)).

---

## Timestamps

Every row gets `createdAt` and `updatedAt`:

```ts
const todo = await db.insert(["todos"], { title: "Walk" });
todo.value.createdAt; // 1790000000000

await db.set(todo.key, { ...todo.value, title: "Run" }); // updatedAt = now
await db.insert(["todos"], { title: "Old", createdAt: 1600000000000 }); // override
```

Disable per table with `timestamps: false`.

---

## Relations

A `"{table.placeholder}"` field is a foreign key: it must exist, it's indexed,
and deletes are restricted unless you cascade.

```ts
tables: [
  {
    key: ["authors", "{authorId}"],
    schema: { id: "{authorId}", name: "string" },
  },
  {
    key: ["books", "{bookId}"],
    schema: { id: "{bookId}", authorId: "{authors.authorId}", title: "string" },
  },
]
```

```ts
const le = await db.insert(["authors"], { name: "Le Guin" });
await db.insert(["books"], { authorId: le.value.id, title: "The Dispossessed" });

await db.list(["books"], { where: { authorId: le.value.id } });

await db.insert(["books"], { authorId: "nobody", title: "?" }); // KrvReferenceError
await db.delete(le.key); // KrvReferenceError: referenced by books/…
await db.delete(le.key, { cascade: true }); // deletes her books too
```

- `"authorId?": "{authors.authorId}"` or `["{authors.authorId}", null]` makes
  it optional.
- Changing a row's key (`set` with a new `id`) moves it, and references
  follow.

---

## Expanding relations

`get`, `list` and `find` can include related rows with `expand`. You choose
the property name; the string says which reference to follow, and its
direction decides the shape:

| `expand: { name: … }`     | Follows                                    | Gives                 |
| ------------------------- | ------------------------------------------ | --------------------- |
| `"authorId"`              | a reference field of this row              | one row, or `null`    |
| `"books.authorId"`        | another table's field pointing to this row | a list of rows        |

```ts
const book = await db.find(["books"], {
  where: { title: "The Dispossessed" },
  expand: { author: "authorId" },
});
book.author.name; // "Le Guin" (book.authorId is still there)

const authors = await db.list(["authors"], {
  expand: { books: "books.authorId" },
});
authors[0].books; // [{ id, title, … }, …]
```

Reverse expands take list options, and anything can be nested:

```ts
await db.list(["authors"], {
  expand: {
    books: {
      from: "books.authorId",
      where: { published: true },
      filter: (book) => book.year > 1970,
      limit: 5,
      reverse: true,
      expand: { reviews: "reviews.bookId" },
    },
  },
});
```

- A table keyed by the reference itself (1:1, like
  `["profiles", "{authorId}"]`) gives one row or `null` instead of a list.
- Names can't clash with fields; wrong fields or tables are compile errors.
- Forward expands are read in batches; reverse ones use the reference's index
  (one read per row). Expanded rows are separate reads, not a snapshot.

---

## Updating

`update` changes part of a row without reading it first. The patch is merged
into the stored row in one atomic commit; if another write lands in between,
it's merged again on top of it.

```ts
await db.update(["products", "p1"], { price: 9.5 });
await db.update(["products", "p1"], { dimensions: { height: 2 } }); // merged
await db.update(["products", "p1"], { "tags": ["sale"] }); // replaced
await db.update(["products", "p1"], { discount: undefined }); // removed

// From the current value: concurrent updates never overwrite each other.
await db.update(["posts", id], (post) => ({ views: post.views + 1 }));
```

- Nested objects merge; arrays and maps (`[]`, `{}`) are replaced whole.
- `undefined` removes a field.
- It returns the updated row, and throws `KrvNotFoundError` if it doesn't
  exist.
- `check: versionstamp` only updates the version you read, e.g. after a user
  edited it in a form: `{ check: entry.versionstamp }` (entries come from
  `values: false`).
- Everything else works as `set`: validation, transforms, indexes, relations
  and `updatedAt`.

---

## Reading: `where` and `filter`

```ts
await db.list(["books"]); // all, oldest first
await db.list(["books"], { reverse: true, limit: 5 }); // 5 newest
await db.list(["books"], { where: { genre: "fantasy" } }); // equality
await db.list(["books"], { where: { meta: { lang: "en" } } }); // partial nested match
await db.list(["books"], {
  where: { authorId }, // narrows what's read
  filter: (b) => b.year < 1980, // any condition, typed
});

for await (const book of db.list(["books"])) {} // stream

const books = await db.list(["books"]); // the rows: books[0].title
const entries = await db.list(["books"], { values: false }); // { key, value, versionstamp }

const book = await db.find(["books"], { where: { isbn: "978-0" } }); // first match or null
```

`list` returns the rows themselves; pass `values: false` to get
`{ key, value, versionstamp }` entries. `find` takes the same options (without
`limit`) and returns the first match, or `null`. `where` uses the key, unique indexes,
indexes and references when it can, otherwise it scans. `filter` runs after
it, and `limit` counts what's left.

---

## Migrations

```ts
// migrations/2026-10-01--todo-priority.ts
import type { KrvMigration } from "./mod.ts";

export default {
  id: "2026-10-01--todo-priority",
  up: async (db) => {
    const todos = db.raw.list<Record<string, unknown>>({ prefix: ["todos"] });
    for await (const { key, value } of todos) {
      await db.raw.set(key, { ...value, priority: 0 });
    }
  },
} satisfies KrvMigration;
```

```ts
const db = await openKRV({
  path: "./todos.db",
  tables: [todos], // a table({ key: ["todos", "{todoId}"], … })
  migrations: [import("./migrations/2026-10-01--todo-priority.ts")],
  events: {
    beforeMigrations: async ({ backupPath }) => await upload(backupPath),
  },
});
```

- `await openKRV` runs pending migrations first, by `id` order, once each.
  `enabled: false` skips one.
- Inside `up`: the usual API, plus `db.raw` (plain `Deno.Kv`, no validation)
  and `db.transforms["&"].save(x)` to transform values by hand for `db.raw`.
- The file is backed up to `<path>.backup` first. If anything fails, it's
  restored and `openKRV` throws. A crash mid-migration is restored on the next
  open.
- `<path>.lock` makes other processes wait while one migrates.
- Events: `beforeMigrations`, `beforeMigration`, `afterMigration`,
  `migrationFailed`, `afterMigrations`. Each is awaited; a throw fails the run.
- With `:memory:` there's no backup: errors are just thrown.

---

## Schema changes

When a table's definition changes (or after a migration), `openKRV` checks the
stored rows and rebuilds the indexes. Old rows that no longer fit refuse to
open until a migration fixes them:

```
KrvSchemaError: Stored rows don't match their tables. Add or fix a migration:
Table "todos": 3 invalid row(s)
  - todos/01J….priority: required
```

---

## API reference

| Method                              | Description                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `openKRV({ path, tables, … })`      | Opens, migrates and checks. Options: `validators`, `transforms`, `migrations`, `events`, `lockTimeout` |
| `table({ key, schema, … })`         | Optional: keeps a table's types when defined outside `openKRV`. Options: `indexes`, `timestamps` |
| `get(key, { expand? })`             | One row, or `value: null`                                                   |
| `insert(literals, value)`           | New row; returns `{ key, value }`                                           |
| `update(key, patch \| (row) => patch, { check? })` | Partial update, merged atomically; returns the row |
| `set(key, value, { check? })`       | Create or replace; `check` a versionstamp for optimistic concurrency        |
| `delete(key, { cascade? })`         | Delete; `cascade` deletes referencing rows                                  |
| `list(literals, { where, filter, limit, reverse, values, expand })` | Rows: await for an array or `for await` to stream; `values: false` for entries |
| `find(literals, { where, filter, reverse, values, expand })` | First matching row, or `null` |
| `compare(key, field, plain)`        | Check a plain value against a transformed field                             |
| `close()`                           | Close the database                                                          |

```ts
const note = await db.get(["notes", id]);
await db.set(["notes", id], { ...note.value!, done: true }, {
  check: note.versionstamp, // KrvConflictError if someone wrote it meanwhile
});
```

---

## Errors

| Error                | When                                                            |
| -------------------- | --------------------------------------------------------------- |
| `KrvSchemaError`     | Invalid setup, stale rows or broken indexes (at open)           |
| `KrvValidationError` | A value doesn't match the schema; `.issues` lists them          |
| `KrvConflictError`   | A `check` failed, a key or unique value is taken                |
| `KrvReferenceError`  | A missing reference, or a delete without `cascade`              |
| `KrvNotFoundError`   | `update` on a row that doesn't exist                            |

```
Invalid value:
  - products.price: expected number, got "9.99"
  - products.size: expected "S" | "M" | "L", got "XL"
```

---

## Guarantees and limits

- Writes are atomic, including indexes, references, cascades and moves.
  Concurrent conflicts are retried; unique values and references hold under
  races, across processes.
- Cascades or moves touching more than ~100 rows can hit Deno KV's per-commit
  limits.
- Transforms and indexes work on top-level fields only.
- `"id"` values are time-ordered ULIDs: don't use them as secrets.
- Processes opened before a migration aren't stopped by the lock.

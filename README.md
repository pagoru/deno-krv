# Deno KRV

**KRV** stands for **Key · Relation · Value**: [Deno KV](https://docs.deno.com/deploy/kv/)'s
key-value store, with relations between the values. A typed, schema-validated
layer where tables reference each other, and every write keeps those
relations consistent.

- Schemas are plain data. Types are inferred from them and every write is
  validated.
- Relations, indexes, timestamps and migrations.
- Built-in hashing, password hashing (bcrypt) and encryption, keyed with
  secrets it creates for you.
- Every write, with its indexes and relations, commits atomically.

```ts
import { openKRV } from "@da/deno-krv";

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
- [Files on disk](#files-on-disk)
- [API reference](#api-reference)
- [Errors](#errors)
- [Guarantees and limits](#guarantees-and-limits)

---

## Setup

```sh
deno add jsr:@da/deno-krv
```

Enable Deno KV in `deno.json`:

```json
{ "unstable": ["kv"] }
```

TypeScript `strict` mode must be on (Deno's default). If you have a
`tsconfig.json`, set `"strict": true`.

A database file needs `--allow-read` and `--allow-write` for its folder: next
to it go its secrets, a lock while opening and a backup while migrating (see
[Files on disk](#files-on-disk)). On Deno Deploy, or anywhere without a
database file, pass [`secrets`](#transforms) yourself.

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
];
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
import { openKRV, table } from "@da/deno-krv";

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

| Type                                                  | Meaning                                    |
| ----------------------------------------------------- | ------------------------------------------ |
| `"string"` `"number"` `"boolean"` `"bigint"` `"date"` | Built-in types                             |
| `"unknown"`                                           | Anything (optional)                        |
| `"id"`                                                | String, a ULID when left empty             |
| `"\|text\|"`                                          | String literal                             |
| `1`, `true`, `null`, `undefined`                      | Raw literals                               |
| `[a, b]`                                              | Union (`[x, undefined]` makes it optional) |
| `{ … }`                                               | Nested object; unknown fields are rejected |
| `"{placeholder}"`                                     | Key field                                  |
| `"{table.placeholder}"`                               | Reference to another table                 |

### Row types

Name a table's types from the database, without writing them twice. They follow
the schema: add a required field and every place that builds a row without it
becomes a compile error.

```ts
import type { KrvInput, KrvRow } from "@da/deno-krv";

export type Db = typeof db;
export type Post = KrvRow<Db, ["posts"]>; // as read back
export type NewPost = KrvInput<Db, ["posts"]>; // what insert accepts

export const createPost = async (input: NewPost): Promise<Post> =>
  (await db.insert(["posts"], input)).value;
```

The table is named by its key's literal parts, as in `insert` and `list`. Custom
validators and transforms resolve through `Db`.

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

A character after a field name stores something else than the plain value.
Four are built in, no setup needed:

| Character | Stores                          | Reads back     | Search                                |
| --------- | ------------------------------- | -------------- | ------------------------------------- |
| `#`       | HMAC-SHA256 (hex) of the value  | The hash       | `where`, indexes                      |
| `*`       | bcrypt (cost 10), peppered      | The hash       | No; check with `compare()`            |
| `&`       | AES-256-GCM of the value (JSON) | The value      | Through an index `using: "#"` (below) |
| `~`       | The value, lowercased           | The lowercased | `where`, indexes (case-insensitive)   |

```ts
const db = await openKRV({
  tables: [
    {
      key: ["members", "{memberId}"],
      schema: {
        id: "{memberId}",
        "pin*": "string", // hashed, check with db.compare
        "nickname#": "string", // hashed, searchable
        "phone&": "string", // encrypted, read back decrypted
        "handle~": "string", // lowercased, searched ignoring case
      },
      indexes: {
        byPhone: { fields: ["phone"], using: "#", unique: true }, // see below
        byHandle: { fields: ["handle"], unique: true }, // "Ana" and "ana" clash
      },
    },
  ],
});

const m = await db.insert(["members"], {
  pin: "1234",
  nickname: "ana",
  phone: "+34600000000",
  handle: "Ana",
});

m.value.phone; // "+34600000000" (decrypted)
m.value.handle; // "ana"
await db.compare(m.key, "pin", "1234"); // true
await db.list(["members"], { where: { nickname: "ana" } }); // hashed, then compared
await db.list(["members"], { where: { phone: "+34600000000" } }); // via byPhone
await db.list(["members"], { where: { handle: "ANA" } }); // lowercased, then compared
```

`~` validates the value as given (so a validator sees `"Ana"`), then stores
it lowercased; the original case isn't kept. Only strings are lowercased.

`#`, `*` and `&` use a secret, so stored values can't be read or guessed from the
database alone (a plain hash of a phone number or a short nickname can be
brute-forced). `#` and `&` derive separate keys (HKDF) from the same `key`
secret. The password is peppered with HMAC-SHA256 before bcrypt, so passwords
of any length work (bcrypt alone only reads 72 bytes). Non-string values are
hashed as JSON; `&` keeps their type (a number reads back as a number).

The secrets live next to the database, in `<path>.secrets`: a binary file
(the `KRVS` header, a version byte, then the 32-byte key and 32-byte pepper),
created on first open with owner-only permissions. Being binary only keeps it
from reading as text: anyone who can read the file has the secrets, so protect
it like the database itself.

**Back it up and keep it out of git**: without it, `#` fields can't be
searched, `*` passwords can't be checked and `&` fields can't be decrypted.
With `":memory:"` they're random for each open. Without a file (Deno's default
location, a remote database), pass them yourself, e.g. from environment
variables:

```ts
const db = await openKRV({
  secrets: {
    key: Deno.env.get("KRV_KEY")!,
    pepper: Deno.env.get("KRV_PEPPER")!,
  },
  tables,
});
```

Passed secrets are used as is and never written. The file is only created
while at least one built-in transform isn't replaced.

Declare your own transforms under `transforms`, with any character that can't
be part of a field name. Declaring `#`, `*`, `&` or `~` replaces the built-in
one:

```ts
const db = await openKRV({
  transforms: {
    "%": { save: (v) => compress(v), load: (v) => decompress(v) },
  },
  tables,
});
```

| Function                 | Meaning                                       |
| ------------------------ | --------------------------------------------- |
| `save`                   | What gets stored (required)                   |
| `load`                   | Restores the value on read                    |
| `compare(plain, stored)` | Used by `db.compare`                          |
| `deterministic`          | Same input, same output: searchable/indexable |

Validation runs on the plain value. Transforms work on top-level fields, and
on each item of `[]`/`{}`.

**Writing stored values (`raw`)**: to write a value that is already hashed or
encrypted (users imported with their bcrypt hashes, a ciphertext copied from
another row), list the field in `raw`. It's stored as given instead of going
through the transform again. `insert`, `set` and `update` take it:

```ts
await db.update(m.key, { pin: storedHash }, { raw: ["pin"] });
await db.insert(
  ["members"],
  { pin: storedHash, nickname: "ana", phone },
  {
    raw: ["pin"],
  },
);
```

A field with a `load` (like `&`) is loaded first: it must be readable with the
current secrets, it's validated as its plain value and it's returned decrypted.
One without a `load` (`*`, `#`, `~`) isn't validated, since only the stored form is
known. Only transformed fields can be `raw`; with `update`, only those the
patch sets are affected.

**Searching an encrypted field**: an encrypted value (`&`) is different every
time, so it can't be compared as stored. Give it an index `using` a
deterministic transform: the index is keyed by the hash of the plain value, and
`where: { phone }` hashes the searched value the same way. The row only holds
the encrypted phone. Without such an index, searching it is a compile error.
The built-in `#` is keyed (HMAC), so the hash of a phone number can't be
guessed without the key.

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
(see [Transforms](#transforms)). A field already stored with `#` is indexed as
stored, so `using: "#"` on it changes nothing. A field stored with a transform
that can't be read back (like `*`) can't be indexed through another one.

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
];
```

```ts
const le = await db.insert(["authors"], { name: "Le Guin" });
await db.insert(["books"], {
  authorId: le.value.id,
  title: "The Dispossessed",
});

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

| `expand: { name: … }` | Follows                                    | Gives              |
| --------------------- | ------------------------------------------ | ------------------ |
| `"authorId"`          | a reference field of this row              | one row, or `null` |
| `"books.authorId"`    | another table's field pointing to this row | a list of rows     |

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
await db.update(["products", "p1"], { tags: ["sale"] }); // replaced
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

for await (const book of db.list(["books"])) {
} // stream

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

Each migration is a file named `YYYY-MM-DD--NNN[--name].ts`: the date, a
three-digit number for the order within that day, and an optional name.
Create one with:

```sh
deno run -RW jsr:@da/deno-krv/cli new-migration "todo priority"
# Created migrations/2026-10-01--001--todo-priority.ts
```

Or as a task in your `deno.json`, then `deno task new-migration "todo priority"`:

```json
{
  "tasks": {
    "new-migration": "deno run -RW jsr:@da/deno-krv/cli new-migration"
  }
}
```

`--dir=<path>` changes the folder (default `migrations`). The number is the
next one for today among the files there; `--number=N` sets it without reading
the folder (then only `-W` is needed). The same is available in code:
`newMigration(name?, dir?, number?)` from `@da/deno-krv/cli`, and
`nextMigrationName` / `parseMigrationName` from `@da/deno-krv`.

```ts
// migrations/2026-10-01--001--todo-priority.ts
import type { KrvMigration } from "@da/deno-krv";

export default {
  url: import.meta.url, // the file name identifies the migration
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
  migrations: [import("./migrations/2026-10-01--001--todo-priority.ts")],
  events: {
    beforeMigrations: async ({ backupPath }) => await upload(backupPath),
  },
});
```

- `await openKRV` runs pending migrations first, once each, by date and then
  number (not in the order they're listed). `enabled: false` skips one.
- The name comes from `url: import.meta.url`; `openKRV` never reads the
  folder. Only the name is stored, never the path, so moving the project
  changes nothing.
- A migration is recorded as applied by its date and number
  (`2026-10-01--001`): renaming the name part doesn't run it again. Two files
  with the same date and number are rejected.
- Inside `up`: the usual API, plus `db.raw` (plain `Deno.Kv`, no validation)
  and `db.transforms["&"].save(x)` to transform values by hand for `db.raw`.
  Rows are loosely typed unless you give the migration your database's type
  (see [Typed migrations](#typed-migrations)).
- The file is backed up to `<path>.backup` first. If anything fails, it's
  restored and `openKRV` throws. A crash mid-migration is restored on the next
  open.
- `<path>.lock` makes other processes wait while one migrates.
- Events: `beforeMigrations`, `beforeMigration`, `afterMigration`,
  `migrationFailed`, `afterMigrations`. Each is awaited; a throw fails the run.
  Their migrations carry `id` (`2026-10-01--001`), `fileName`
  (`2026-10-01--001--todo-priority`) and `name` (`todo-priority`, if any).
- Applied migrations are stored under `["__krv", "migrations", id]` with
  `id`, `fileName`, `description`, `appliedAt` and `durationMs`.
- With `:memory:` there's no backup: errors are just thrown.

### Typed migrations

`KrvMigration<Db>` types `db` inside `up` with your tables. The type can't
come from `openKRV`'s result, since `openKRV` imports the migrations (that
loop makes everything `any`), so declare the schema apart with `defineKRV` and
spread it into `openKRV`:

```ts
// db/config.ts
import { defineKRV, type KrvDatabaseOf } from "@da/deno-krv";

export const config = defineKRV({
  validators: { email: ["string", (v) => v.includes("@")] },
  tables: [users, posts],
});
export type Db = KrvDatabaseOf<typeof config>;
```

```ts
// db/migrations/2026-10-01--001--seed.ts
import type { KrvMigration } from "@da/deno-krv";
import type { Db } from "../config.ts";

export default {
  url: import.meta.url,
  up: async (db) => {
    await db.insert(["users"], { name: "ana" }); // typed and checked
  },
} satisfies KrvMigration<Db>;
```

```ts
// db/main.ts
import { openKRV } from "@da/deno-krv";
import { config } from "./config.ts";

export const db = await openKRV({
  ...config,
  path: "./app.db",
  migrations: [import("./migrations/2026-10-01--001--seed.ts")],
});
```

`defineKRV` takes `tables`, `validators` and `transforms`, typed and checked
as in `openKRV`. A migration written for an old shape of the data is better
left untyped, with `db.raw`.

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

## Files on disk

With `path: "./app.db"`:

| File                              | What                                      | When                                 |
| --------------------------------- | ----------------------------------------- | ------------------------------------ |
| `app.db`                          | The data (Deno KV, SQLite)                | Always                               |
| `app.db.secrets`                  | Key and pepper of the built-in transforms | Created on first open; keep it       |
| `app.db-wal`, `app.db-shm`        | SQLite's journal                          | While open; removed on `close()`     |
| `app.db.lock`                     | Only one process opens or migrates        | While `openKRV` runs                 |
| `app.db.backup` (+ `-wal`/`-shm`) | Copy taken before migrating               | While migrating; restored on failure |

Keep `app.db` and `app.db.secrets` together, backed up, and out of git:

```gitignore
*.db*
```

`":memory:"` writes nothing. Without a `path` (Deno's default location) Deno
manages the data and no file is written, so pass `secrets`.

---

## API reference

| Method                                                              | Description                                                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `openKRV({ path, tables, … })`                                      | Opens, migrates and checks. Options: `validators`, `transforms`, `migrations`, `events`, `secrets`, `lockTimeout` |
| `table({ key, schema, … })`                                         | Optional: keeps a table's types when defined outside `openKRV`. Options: `indexes`, `timestamps`                  |
| `get(key, { expand? })`                                             | One row, or `value: null`                                                                                         |
| `insert(literals, value, { raw? })`                                 | New row; returns `{ key, value }`                                                                                 |
| `update(key, patch \| (row) => patch, { check?, raw? })`            | Partial update, merged atomically; returns the row                                                                |
| `set(key, value, { check?, raw? })`                                 | Create or replace; `check` a versionstamp for optimistic concurrency; `raw` fields are written as stored          |
| `delete(key, { cascade? })`                                         | Delete; `cascade` deletes referencing rows                                                                        |
| `list(literals, { where, filter, limit, reverse, values, expand })` | Rows: await for an array or `for await` to stream; `values: false` for entries                                    |
| `find(literals, { where, filter, reverse, values, expand })`        | First matching row, or `null`                                                                                     |
| `compare(key, field, plain)`                                        | Check a plain value against a transformed field                                                                   |
| `close()`                                                           | Close the database                                                                                                |

Also exported:

| Export                                              | What                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `defineKRV({ tables, validators?, transforms? })`   | The schema part of `openKRV`'s options, declared apart; spread it into `openKRV`                                    |
| `KrvDatabaseOf<typeof config>`                      | The database type of a `defineKRV` config                                                                           |
| `nextMigrationName(existing, name?, now?, number?)` | The next `YYYY-MM-DD--NNN[--name]` for today after `existing` file names                                            |
| `parseMigrationName(fileName)`                      | `{ id, date, number, name? }`, or `null` if it isn't a migration name                                               |
| `newMigration(name?, dir?, number?)`                | From `@da/deno-krv/cli`: writes a new migration file, returns its path                                              |
| `KrvDatabase<Tables, Env>`                          | The type of an open database                                                                                        |
| `KrvMigration<Db?>`, `KrvLoadedMigration`           | A migration as written (`url`, `up`, …; `db` typed as `Db` if given), and as loaded (plus `id`, `fileName`, `name`) |
| `KrvSecrets`                                        | `{ key, pepper }` for the `secrets` option                                                                          |
| `KrvDefaultTransforms`                              | The types of the built-in `#`, `*`, `&` and `~`                                                                     |

To name the database type in your code, use `defineKRV` (see
[Typed migrations](#typed-migrations)), or take it from the open call when
nothing it imports needs the type:

```ts
export const open = () => openKRV({ path: "./app.db", tables });
export type Db = Awaited<ReturnType<typeof open>>;
```

```ts
const note = await db.get(["notes", id]);
await db.set(
  ["notes", id],
  { ...note.value!, done: true },
  {
    check: note.versionstamp, // KrvConflictError if someone wrote it meanwhile
  },
);
```

---

## Errors

| Error                | When                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `KrvSchemaError`     | Invalid setup, stale rows or broken indexes (at open)                                                                           |
| `KrvValidationError` | A value doesn't match the schema; `.issues` lists them                                                                          |
| `KrvConflictError`   | A `check` failed, a key or unique value is taken                                                                                |
| `KrvReferenceError`  | A missing reference, or a delete without `cascade`                                                                              |
| `KrvNotFoundError`   | `update` on a row that doesn't exist                                                                                            |
| `Error`              | A built-in transform without secrets, a damaged `.secrets` file, or an `&` value that can't be decrypted (wrong key or altered) |

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
- bcrypt (`*`) runs in the calling thread: about 60ms per save or
  `compare`, during which nothing else runs.
- Losing the `.secrets` file (or the `secrets` you pass) makes `#` fields
  unsearchable, `*` passwords uncheckable and `&` fields unreadable.
- Processes opened before a migration aren't stopped by the lock.

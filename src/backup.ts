import type { KrvSecrets } from "./secrets.ts";

/**
 * A backup file: "KRVB", the format version, a PBKDF2 salt and an AES-GCM
 * nonce, then the encrypted, gzipped payload: the secrets as JSON
 * (length-prefixed, empty without secrets) and the database file.
 */
const MAGIC = [0x4b, 0x52, 0x56, 0x42];
const VERSION = 1;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const HEADER_LENGTH = MAGIC.length + 1 + SALT_LENGTH + NONCE_LENGTH;
const PBKDF2_ITERATIONS = 600_000;

export type BackupContents = {
  /** The built-in transforms' secrets, or null when none are in use. */
  secrets: KrvSecrets | null;
  /** The SQLite database file. */
  database: Uint8Array;
};

const passwordKey = async (password: string, salt: Uint8Array) =>
  crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveKey"],
    ),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

const pipe = async (bytes: Uint8Array, stream: TransformStream) =>
  new Uint8Array(
    await new Response(
      new Blob([bytes as BlobPart]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );

/** Encrypts `contents` with `password` into a backup file's bytes. */
export const pack = async (
  contents: BackupContents,
  password: string,
): Promise<Uint8Array> => {
  const secrets = contents.secrets
    ? new TextEncoder().encode(JSON.stringify(contents.secrets))
    : new Uint8Array();
  const plain = new Uint8Array(4 + secrets.length + contents.database.length);
  new DataView(plain.buffer).setUint32(0, secrets.length);
  plain.set(secrets, 4);
  plain.set(contents.database, 4 + secrets.length);

  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      await passwordKey(password, salt),
      (await pipe(plain, new CompressionStream("gzip"))) as BufferSource,
    ),
  );

  const file = new Uint8Array(HEADER_LENGTH + encrypted.length);
  file.set(MAGIC);
  file[MAGIC.length] = VERSION;
  file.set(salt, MAGIC.length + 1);
  file.set(nonce, MAGIC.length + 1 + SALT_LENGTH);
  file.set(encrypted, HEADER_LENGTH);
  return file;
};

/** Decrypts a backup file's bytes. Throws on a wrong password or altered bytes. */
export const unpack = async (
  file: Uint8Array,
  password: string,
): Promise<BackupContents> => {
  if (
    file.length < HEADER_LENGTH ||
    MAGIC.some((byte, i) => file[i] !== byte)
  ) {
    throw new Error("Not a krv backup");
  }
  if (file[MAGIC.length] !== VERSION) {
    throw new Error(
      `Unsupported backup version ${file[MAGIC.length]} (expected ${VERSION})`,
    );
  }
  const salt = file.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LENGTH);
  const nonce = file.subarray(MAGIC.length + 1 + SALT_LENGTH, HEADER_LENGTH);

  let compressed: Uint8Array;
  try {
    compressed = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource },
        await passwordKey(password, salt),
        file.subarray(HEADER_LENGTH) as BufferSource,
      ),
    );
  } catch {
    throw new Error("Wrong password or damaged backup");
  }

  const plain = await pipe(compressed, new DecompressionStream("gzip"));
  const secretsLength = new DataView(plain.buffer).getUint32(0);
  return {
    secrets: secretsLength
      ? JSON.parse(new TextDecoder().decode(plain.slice(4, 4 + secretsLength)))
      : null,
    database: plain.slice(4 + secretsLength),
  };
};

/**
 * `node:sqlite`, loaded only when a backup is taken. Its specifier isn't a
 * literal so that type-checking krv doesn't need `@types/node`.
 */
const SQLITE: string = "node:sqlite";
type NodeSqlite = {
  DatabaseSync: new (
    path: string,
    options: { readOnly: boolean },
  ) => { close(): void };
  backup: (source: unknown, path: string) => Promise<number>;
};

/**
 * A consistent copy of the database file, taken with SQLite's online backup
 * while Deno KV keeps it open (and writing).
 */
export const snapshot = async (path: string): Promise<Uint8Array> => {
  const sqlite = (await import(SQLITE)) as NodeSqlite;
  const copy = `${path}.snapshot`;
  const source = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    await sqlite.backup(source, copy);
    return await Deno.readFile(copy);
  } finally {
    source.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      await Deno.remove(copy + suffix).catch(() => {});
    }
  }
};

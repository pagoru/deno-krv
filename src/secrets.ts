import { isFilePath } from "./migrate.ts";

/**
 * Secrets for the built-in transforms:
 * - `key`: the keys of `#` (HMAC) and `&` (AES-GCM) are derived from it.
 * - `pepper`: mixed into every `*` password before bcrypt.
 *
 * Losing them makes every stored `#`, `*` and `&` value useless: keep a copy
 * outside the database.
 */
export type KrvSecrets = { key: string; pepper: string };

/** File header: "KRVS", then the format version. */
const MAGIC = [0x4b, 0x52, 0x56, 0x53];
const VERSION = 1;
const SECRET_LENGTH = 32;
const HEADER_LENGTH = MAGIC.length + 1;
const FILE_LENGTH = HEADER_LENGTH + 2 * SECRET_LENGTH;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** `<path>.secrets`: header, 32-byte key, 32-byte pepper. */
export const secretsPath = (path: string) => `${path}.secrets`;

const decode = (file: string, bytes: Uint8Array): KrvSecrets => {
  if (
    bytes.length !== FILE_LENGTH ||
    MAGIC.some((byte, i) => bytes[i] !== byte)
  ) {
    throw new Error(`${file} isn't a krv secrets file`);
  }
  if (bytes[MAGIC.length] !== VERSION) {
    throw new Error(
      `${file}: unsupported version ${bytes[MAGIC.length]} (expected ${VERSION})`,
    );
  }
  const key = bytes.subarray(HEADER_LENGTH, HEADER_LENGTH + SECRET_LENGTH);
  const pepper = bytes.subarray(HEADER_LENGTH + SECRET_LENGTH);
  return { key: hex(key), pepper: hex(pepper) };
};

/** New random secrets, as the bytes of a secrets file. */
const generate = () => {
  const bytes = new Uint8Array(FILE_LENGTH);
  bytes.set(MAGIC);
  bytes[MAGIC.length] = VERSION;
  crypto.getRandomValues(bytes.subarray(HEADER_LENGTH));
  return bytes;
};

/** Reads the secrets file, creating it (owner-only) if missing. */
const readOrCreate = async (file: string): Promise<KrvSecrets> => {
  try {
    return decode(file, await Deno.readFile(file));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const bytes = generate();
  await Deno.writeFile(file, bytes, { createNew: true, mode: 0o600 });
  return decode(file, bytes);
};

/**
 * The secrets of the built-in transforms, if any is in use (`needed`):
 * - passed to `openKRV`: those;
 * - with a database file: `<path>.secrets`, a binary file created on first
 *   open;
 * - `":memory:"`: new random ones.
 *
 * Otherwise (Deno's default location, a remote database) there's nowhere to
 * keep them, and they're missing: the built-in transforms throw when used.
 */
export const loadSecrets = async (
  path: string | undefined,
  given: KrvSecrets | undefined,
  needed: boolean,
): Promise<Partial<KrvSecrets>> => {
  if (given) return given;
  if (!needed) return {};
  if (isFilePath(path)) return await readOrCreate(secretsPath(path));
  if (path === ":memory:") return decode(path, generate());
  return {};
};

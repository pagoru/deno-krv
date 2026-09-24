import * as bcrypt from "./crypto/bcrypt.ts";
import type { KrvSecrets } from "./secrets.ts";

/** bcrypt work factor: 2^10 rounds. */
const BCRYPT_COST = 10;
/** AES-GCM nonce length, in bytes. */
const IV_LENGTH = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

type Purpose = "hash" | "encrypt" | "pepper";

const keys = new Map<string, Promise<CryptoKey>>();

/**
 * A key for one purpose, derived from a secret with HKDF-SHA256, so `#` and
 * `&` never use the same key even though they share the `key` secret.
 */
const deriveKey = (secret: string, purpose: Purpose): Promise<CryptoKey> => {
  const id = `${purpose}:${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(),
          info: encoder.encode(`krv:${purpose}`),
        },
        material,
        purpose === "encrypt"
          ? { name: "AES-GCM", length: 256 }
          : { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        purpose === "encrypt" ? ["encrypt", "decrypt"] : ["sign"],
      );
    })();
    keys.set(id, key);
  }
  return key;
};

/** HMAC-SHA256 of `value`. */
const hmac = async (secret: string, purpose: Purpose, value: unknown) =>
  new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await deriveKey(secret, purpose),
      encoder.encode(text(value)),
    ),
  );

/** AES-256-GCM of `value` as JSON: base64 of nonce + ciphertext + tag. */
const encrypt = async (secret: string, value: unknown) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await deriveKey(secret, "encrypt"),
    encoder.encode(JSON.stringify(value)),
  );
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ciphertext), IV_LENGTH);
  return toBase64(out);
};

/** Reverses `encrypt`. Throws if the value was changed or the key differs. */
const decrypt = async (secret: string, stored: string) => {
  const bytes = fromBase64(stored);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_LENGTH) },
    await deriveKey(secret, "encrypt"),
    bytes.subarray(IV_LENGTH),
  );
  return JSON.parse(decoder.decode(plain));
};

/** The built-in transforms, as seen by the row types. */
export type KrvDefaultTransforms = {
  "#": {
    save: (value: unknown) => Promise<string>;
    deterministic: true;
  };
  "*": {
    save: (value: unknown) => Promise<string>;
    compare: (plain: unknown, stored: string) => Promise<boolean>;
  };
  "&": {
    save: (value: unknown) => Promise<string>;
    load: (stored: string) => Promise<unknown>;
  };
};

/** The default transforms, minus those replaced by `T`, plus `T`. */
export type KrvWithDefaultTransforms<T> = Omit<KrvDefaultTransforms, keyof T> &
  T;

/** Which secret each built-in transform needs. */
export const DEFAULT_TRANSFORM_SECRETS: Record<
  keyof KrvDefaultTransforms,
  keyof KrvSecrets
> = { "#": "key", "*": "pepper", "&": "key" };

/**
 * Transforms available without declaring them. Ones passed to `openKRV` with
 * the same character replace them.
 * - `#`: HMAC-SHA256 (hex), keyed from the `key` secret. Deterministic, so
 *   searchable and indexable, but can't be guessed without the key.
 * - `*`: bcrypt of the password peppered with the `pepper` secret
 *   (HMAC-SHA256, base64, so any length fits bcrypt's 72 bytes). Salted:
 *   only checkable with `db.compare`.
 * - `&`: AES-256-GCM, keyed from the `key` secret. Read back decrypted; a
 *   random nonce makes it not searchable (index it `using: "#"`).
 */
export const createDefaultTransforms = (
  secrets: () => Partial<KrvSecrets>,
): KrvDefaultTransforms => {
  const secret = (char: keyof KrvDefaultTransforms) => {
    const name = DEFAULT_TRANSFORM_SECRETS[char];
    const value = secrets()[name];
    if (value === undefined) {
      throw new Error(
        `transforms["${char}"] needs a ${name}: pass \`secrets\` to openKRV ` +
          `(there's no database file to keep it next to)`,
      );
    }
    return value;
  };
  const pepper = async (password: unknown) =>
    toBase64(await hmac(secret("*"), "pepper", password));

  return {
    "#": {
      save: async (value) => hex(await hmac(secret("#"), "hash", value)),
      deterministic: true,
    },
    "*": {
      save: async (value) =>
        bcrypt.hash(await pepper(value), bcrypt.genSalt(BCRYPT_COST)),
      compare: async (plain, stored) =>
        bcrypt.compare(await pepper(plain), stored),
    },
    "&": {
      save: async (value) => await encrypt(secret("&"), value),
      load: async (stored) => await decrypt(secret("&"), stored),
    },
  };
};

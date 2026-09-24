/**
 * Stand-ins for real crypto, with the same properties:
 * - `sha256`: deterministic hash.
 * - `slowHash` / `slowCompare`: salted hash, like bcrypt (not deterministic).
 * - `encrypt` / `decrypt`: reversible, random IV (not deterministic).
 */

export const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

export const slowHash = async (value: string) => {
  const salt = crypto.randomUUID().slice(0, 8);
  return `$fake$${salt}$${await sha256(salt + value)}`;
};

export const slowCompare = async (plain: string, stored: string) => {
  const [, , salt, hash] = stored.split("$");
  return hash === (await sha256(salt + plain));
};

export const encrypt = (value: string) =>
  `enc:${crypto.randomUUID().slice(0, 8)}:${btoa(value)}`;

export const decrypt = (stored: string) => {
  if (!stored.startsWith("enc:")) throw new Error("not encrypted");
  return atob(stored.split(":")[2]);
};

export const transforms = {
  "*": { save: slowHash, compare: slowCompare },
  "#": { save: sha256, deterministic: true },
  "&": { save: encrypt, load: decrypt },
} as const;

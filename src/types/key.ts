export type KrvKeyPart =
  Uint8Array | string | number | bigint | boolean | symbol;

export type KrvKey = readonly KrvKeyPart[];

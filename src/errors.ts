import type { KrvKey } from "./types/main.ts";

export class KrvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid value:\n  - ${issues.join("\n  - ")}`);
    this.name = "KrvValidationError";
  }
}

/**
 * A write lost to another one: a `check` failed, a key or unique value is
 * already taken, or concurrent writes kept winning.
 */
export class KrvConflictError extends Error {
  constructor(readonly key: KrvKey, message?: string) {
    super(
      message ??
        `Conflict: versionstamp check failed for ${key.map(String).join("/")}`,
    );
    this.name = "KrvConflictError";
  }
}

/** A foreign key points at a missing row, or a delete is restricted by references. */
export class KrvReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KrvReferenceError";
  }
}

/** The row to update doesn't exist. */
export class KrvNotFoundError extends Error {
  constructor(readonly key: KrvKey) {
    super(`Not found: ${key.map(String).join("/")}`);
    this.name = "KrvNotFoundError";
  }
}

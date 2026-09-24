const MAX_ATTEMPTS = 20;
const MAX_DELAY_MS = 100;

const isLocked = (error: unknown) =>
  error instanceof Error && error.message.includes("database is locked");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter so competing writers spread out. */
export const backoff = (attempt: number) =>
  sleep(Math.random() * Math.min(2 ** attempt, MAX_DELAY_MS));

/**
 * Commits a fresh atomic operation from `build`, retrying when SQLite reports
 * `database is locked` (another connection to the same file is writing).
 * A failed versionstamp check is not retried: it comes back as `{ ok: false }`.
 */
export const commitWithLockRetry = async (
  build: () => Deno.AtomicOperation,
): Promise<Deno.KvCommitResult | Deno.KvCommitError> => {
  for (let attempt = 1;; attempt++) {
    try {
      return await build().commit();
    } catch (error) {
      if (!isLocked(error) || attempt >= MAX_ATTEMPTS) throw error;
      await backoff(attempt);
    }
  }
};

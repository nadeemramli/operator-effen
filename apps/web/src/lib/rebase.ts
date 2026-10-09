/**
 * Server-side rebase for the one-document-per-site store.
 *
 * A save loads the latest state, validates and applies the command to it and commits with
 * that state's revision. When another save committed in between, the commit matches no row
 * ("stale"); the attempt is then repeated on the fresh state. This is safe because
 * `applyCommand` validates every command against the state it is applied to (stock,
 * duplicates, stale `expectedVersion`, …) and the database re-checks its invariants; the
 * operation ID, checked first in every attempt, makes a repeated attempt idempotent.
 * The client's revision is a hint, not a lock.
 */
export const MAX_REBASE_ATTEMPTS = 3;

export type RebaseStep<R> = { done: R } | { stale: true };

export async function rebaseLoop<R>(
  attempt: (n: number) => Promise<RebaseStep<R>>,
  exhausted: () => R,
  attempts = MAX_REBASE_ATTEMPTS,
): Promise<R> {
  for (let n = 1; n <= attempts; n++) {
    const step = await attempt(n);
    if ("done" in step) return step.done;
  }
  return exhausted();
}

/** Shown when every attempt lost the race: the client reloads and keeps the form open. */
export const STALE_MESSAGE =
  "Someone else changed this record while you were editing.";

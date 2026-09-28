// What Scheduling's Review & publish sheet says when a publish did not come
// back clean (K2.8 review fix, Codex on #646).
//
// A PATCH can commit and its reply be lost: on one bar of signal the crew can
// already see the schedule while the phone holds a network error. The sheet
// used to append "Nothing was published" to EVERY caught error, which was a
// claim it could not make. The rule now: a transport error is "unconfirmed"
// until the rows are re-read (lib/schedule/api confirmPublished); "nothing was
// published" is said only for a refusal the database itself returned, where
// the transaction rolled back. Pure, so the three shapes are tested without a
// network.
import { isNetworkError } from "../offline/outbox-core";
import type { PublishReadback } from "./api";

export type PublishOutcome =
  /** Every row the publish was sent for is confirmed published: treat as success. */
  | { kind: "published"; ids: string[] }
  /** The database confirmed some, and the rest are still drafts. */
  | { kind: "partial"; published: string[]; drafts: string[] }
  /** The reply was lost and the re-read failed too, or some rows could not be read back. */
  | { kind: "unconfirmed" }
  /** The database answered and said no; nothing changed. */
  | { kind: "refused"; message: string };

/**
 * A lost reply looks like a network failure to the phone (a TypeError from
 * fetch, "Failed to fetch", "load failed", a timeout). Anything else came back
 * from PostgREST or Postgres as an answer, and an answer that is an error
 * means the update did not commit.
 */
export function isUnconfirmedPublishError(err: unknown): boolean {
  return isNetworkError(err);
}

/**
 * Decide from what the re-read found. `readback` is null when the re-read
 * itself failed — the phone still has no signal — so nothing is known.
 * A row that could not be read back (deleted meanwhile, or hidden by row
 * security) is also "not confirmed": better to say so than to guess either way.
 */
export function outcomeFromReadback(readback: PublishReadback | null): PublishOutcome {
  if (!readback) return { kind: "unconfirmed" };
  if (readback.missing.length > 0) return { kind: "unconfirmed" };
  if (readback.drafts.length === 0) return { kind: "published", ids: readback.published };
  return { kind: "partial", published: readback.published, drafts: readback.drafts };
}

/** The sentence the sheet shows for an outcome that is not plain success. */
export function publishOutcomeMessage(outcome: Exclude<PublishOutcome, { kind: "published" }>): string {
  switch (outcome.kind) {
    case "refused":
      return `${outcome.message} Nothing was published.`;
    case "partial":
      return `Published ${outcome.published.length} of ${outcome.published.length + outcome.drafts.length}; ${outcome.drafts.length} still draft. Tap Publish again when you have signal.`;
    case "unconfirmed":
      return "We couldn't confirm whether this was published — the reply never arrived. When you have signal, refresh and check the board before publishing again.";
  }
}

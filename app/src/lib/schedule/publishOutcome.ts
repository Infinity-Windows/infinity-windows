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
  /**
   * Some subset is confirmed published; `total` is every id the click was
   * for. `published` is ONLY ids this action itself is credited with — never
   * a row read back as already published by someone else, and never a
   * missing/unreadable one. Whatever total - published - drafts - canceled
   * comes to (already published elsewhere, unreadable, or any other status)
   * is reported as one honest "changed or could not be confirmed" bucket
   * rather than guessed into any of the other three.
   */
  | { kind: "partial"; published: string[]; drafts: string[]; canceled: string[]; total: number }
  /** The reply was lost and the re-read failed too, or nothing at all was confirmed. */
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
 *
 * A row that could not be read back (deleted meanwhile, or hidden by row
 * security) used to collapse the WHOLE re-read to "unconfirmed" the moment
 * any single id was missing — so a lost reply that re-read as "A published,
 * B missing" told the supervisor nothing was confirmed and never notified
 * A's crew, even though A genuinely was. Missing (and canceled) rows are
 * real answers about THOSE rows; they say nothing about a DIFFERENT row the
 * same read confirmed as published. "unconfirmed" is now reserved for when
 * the read itself failed, or found nothing confirmed at all.
 */
export function outcomeFromReadback(readback: PublishReadback | null): Exclude<PublishOutcome, { kind: "refused" }> {
  if (!readback) return { kind: "unconfirmed" };
  const total = readback.published.length + readback.drafts.length + readback.canceled.length + readback.missing.length;
  if (readback.published.length === total) return { kind: "published", ids: readback.published };
  if (readback.published.length === 0 && readback.drafts.length === 0 && readback.canceled.length === 0) {
    return { kind: "unconfirmed" };
  }
  return { kind: "partial", published: readback.published, drafts: readback.drafts, canceled: readback.canceled, total };
}

/** The sentence the sheet shows for an outcome that is not plain success. */
export function publishOutcomeMessage(outcome: Exclude<PublishOutcome, { kind: "published" }>): string {
  switch (outcome.kind) {
    case "refused":
      return `${outcome.message} Nothing was published.`;
    case "partial": {
      const parts = [`Published ${outcome.published.length} of ${outcome.total}.`];
      if (outcome.drafts.length > 0) parts.push(`${outcome.drafts.length} still draft — tap Publish again when you have signal.`);
      if (outcome.canceled.length > 0) {
        parts.push(`${outcome.canceled.length} ${outcome.canceled.length === 1 ? "was" : "were"} canceled and could not be published.`);
      }
      // Already published by someone else, unreadable, or any other status:
      // never guessed into one of the buckets above, and never left silently
      // uncounted — that gap is exactly what used to read as "Published 2 of
      // 2" for a row this action never touched.
      const other = outcome.total - outcome.published.length - outcome.drafts.length - outcome.canceled.length;
      if (other > 0) {
        parts.push(other === 1 ? "The other entry changed or could not be confirmed." : `${other} other entries changed or could not be confirmed.`);
      }
      return parts.join(" ");
    }
    case "unconfirmed":
      return "We couldn't confirm whether this was published — the reply never arrived. When you have signal, refresh and check the board before publishing again.";
  }
}

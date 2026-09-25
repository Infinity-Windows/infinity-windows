// One sync status over EVERY queue on the phone (K0.6, 2026-09-23). Pure, so
// the pill component exports only a component and the rule has a test.
//
// There are six places a write can be waiting: the main outbox (clock
// punches, photos, memos, receipts, warehouse writes), the install outbox
// (finished units), the custom-work command queue, the servicing command
// queue, the servicing evidence store, and — until its first start after the
// update has moved them — the retired upload queue. The pill used to count
// three of them, and "All synced" over a memo that had been sitting in the
// fourth for a week is the report from the crews that this exists to end.
// The rule here is the simple one: the pill says "All synced" only when EVERY
// one of them is empty, and turns to "needs you" when ANY of them has given
// up.

import type { TFn } from "../i18n";
import type { PillSummary, PillTone } from "./outbox-core";

/**
 * The one place the pill opens, whatever is queued (fold-in F5). It used to
 * open Current Work when custom work was queued and /stuck otherwise — the
 * same tap taking a person to two different screens depending on state they
 * could not see. /stuck lists every queue now, and links out to the screens
 * that own their own review.
 */
export const PILL_DESTINATION = "/stuck";

export interface QueueSnapshot {
  /** Main-outbox writes still to be sent — what the base summary counted. */
  basePending: number;
  installsPending: number;
  installsFailed: number;
  workPending: number;
  workFailed: number;
  servicePending: number;
  serviceFailed: number;
  /** Items still in the old upload store, not moved into the outbox yet. */
  legacyPending: number;
}

export const EMPTY_SNAPSHOT: QueueSnapshot = {
  basePending: 0,
  installsPending: 0,
  installsFailed: 0,
  workPending: 0,
  workFailed: 0,
  servicePending: 0,
  serviceFailed: 0,
  legacyPending: 0,
};

/**
 * Lay every other queue over the main outbox's summary.
 *
 * Words for each non-empty queue go on the face in a fixed order, after the
 * base label; a queue that has given up on something says so in its own
 * words and turns the whole pill to "needs you". The detail sentence is
 * rebuilt from the totals rather than stitched from six sentences, so a
 * screen reader hears one thing.
 */
export function combineQueues(base: PillSummary, q: QueueSnapshot, t: TFn): PillSummary {
  const parts: string[] = base.tone === "synced" ? [] : [base.label];
  let failed = base.tone === "attention";

  if (q.installsFailed > 0) {
    failed = true;
    parts.push(
      q.installsFailed === 1
        ? t("pill.installNeedsYouOne")
        : t("pill.installsNeedYouMany", { n: q.installsFailed }),
    );
  } else if (q.installsPending > 0) {
    parts.push(
      q.installsPending === 1
        ? t("pill.installQueuedOne")
        : t("pill.installsQueuedMany", { n: q.installsPending }),
    );
  }

  if (q.workFailed > 0) {
    failed = true;
    parts.push(t("pill.workNeedsReview"));
  } else if (q.workPending > 0) {
    parts.push(
      q.workPending === 1
        ? t("pill.workQueuedOne")
        : t("pill.workQueuedMany", { n: q.workPending }),
    );
  }

  if (q.serviceFailed > 0) {
    failed = true;
    parts.push(t("pill.serviceNeedsReview"));
  } else if (q.servicePending > 0) {
    parts.push(
      q.servicePending === 1
        ? t("pill.serviceQueuedOne")
        : t("pill.serviceQueuedMany", { n: q.servicePending }),
    );
  }

  if (q.legacyPending > 0) parts.push(t("pill.oldUploadsQueued", { n: q.legacyPending }));

  const pending =
    q.basePending +
    q.installsPending +
    q.workPending +
    q.servicePending +
    q.legacyPending;

  if (!failed && pending === 0) return base;

  const tone: PillTone = failed ? "attention" : "syncing";
  const waiting =
    pending === 0
      ? ""
      : pending === 1
        ? t("pill.waitingDetailOne")
        : t("pill.waitingDetailMany", { n: pending });
  return {
    tone,
    label: parts.join(" · "),
    detail: failed ? [t("pill.needsYouDetail"), waiting].filter(Boolean).join(" ") : waiting,
  };
}

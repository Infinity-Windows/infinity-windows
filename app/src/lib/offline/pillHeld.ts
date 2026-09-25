// Work on this phone that is not the signed-in person's to send, laid over the
// sync pill (2026-09-25). PURE, so the pill component exports only a component
// and the rule has a test — the same split as pillConnection.ts.
//
// A write goes out only as the person who saved it (entryOwner.ts), so two
// kinds of work can sit on a phone that nobody here may send: someone else's
// (it waits for them), and work saved before an update that names no one (it
// is never sent as anyone; Stuck writes lets a person throw it away). Neither
// is this person's pending work — they must not be counted as "Photos 2" —
// and neither is synced: "All synced" over them would be the dishonest answer.

import type { TFn } from "../i18n";
import type { PillSummary } from "./outbox-core";

export interface HeldWork {
  /** Someone else's writes, waiting for them to sign in. */
  theirs: number;
  /** Writes saved before an update, whose owner nobody can tell. */
  unknown: number;
}

export function withHeld(pill: PillSummary, held: HeldWork, t: TFn): PillSummary {
  const parts: string[] = [];
  const sentences: string[] = [];
  if (held.theirs > 0) {
    parts.push(t("pill.held", { count: held.theirs }));
    sentences.push(t("pill.heldDetail"));
  }
  if (held.unknown > 0) {
    parts.push(t("pill.unknownOwner", { count: held.unknown }));
    sentences.push(t("pill.unknownOwnerDetail"));
  }
  if (parts.length === 0) return pill;
  if (pill.tone === "synced") return { tone: "syncing", label: parts.join(" · "), detail: sentences.join(" ") };
  return {
    tone: pill.tone,
    label: [pill.label, ...parts].join(" · "),
    detail: [pill.detail, ...sentences].join(" "),
  };
}

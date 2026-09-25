// Someone else's work on this phone, laid over the sync pill (2026-09-25).
// PURE, so the pill component exports only a component and the rule has a
// test — the same split as pillConnection.ts.
//
// A write goes out only as the person who saved it (entryOwner.ts), so while
// somebody else is signed in, that write waits. It is not this person's
// pending work and must not be counted as "Photos 2", and it is not synced
// either: saying "All synced" over it would be the dishonest answer.

import type { TFn } from "../i18n";
import type { PillSummary } from "./outbox-core";

export function withHeld(pill: PillSummary, held: number, t: TFn): PillSummary {
  if (held <= 0) return pill;
  const part = t("pill.held", { count: held });
  const sentence = t("pill.heldDetail");
  if (pill.tone === "synced") return { tone: "syncing", label: part, detail: sentence };
  return { tone: pill.tone, label: `${pill.label} · ${part}`, detail: `${pill.detail} ${sentence}` };
}

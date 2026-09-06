// How the connection state lays over the sync pill's queue summary. Pure,
// so the pill component exports only a component and the rule has a test.

import type { TFn } from "../i18n";
import type { PillSummary, PillTone } from "./outbox-core";

/** The pill's tones, plus the two the connection adds (ticket 06). */
type DisplayTone = PillTone | "offline" | "weak";
interface DisplayPill {
  tone: DisplayTone;
  label: string;
  detail: string;
}

/**
 * Lay the connection over the queue summary. No signal at all wins over
 * everything but "needs attention": a red pill stays red. Weak signal — a
 * request timed out in the last twenty seconds while the phone still says it
 * is online — is the state this ticket exists for: before it, "slow" and
 * "fine" looked identical on the pill. PURE.
 */
export function withConnection(
  pill: PillSummary,
  online: boolean,
  weak: boolean,
  t: TFn,
): DisplayPill {
  if (pill.tone === "attention") return pill;
  const pending = pill.tone !== "synced";
  if (!online) {
    return {
      tone: "offline",
      label: pending ? `${t("pill.noSignal")} · ${pill.label}` : t("pill.noSignal"),
      detail: t("pill.noSignalDetail"),
    };
  }
  if (weak) {
    return {
      tone: "weak",
      label: pending ? `${t("pill.weakSignal")} · ${pill.label}` : t("pill.weakSignal"),
      detail: t("pill.weakDetail"),
    };
  }
  return pill;
}


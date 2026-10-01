import type { TFn } from "../i18n";
import type { PillTone } from "./outbox-core";
import type { OutboxReadState } from "./outbox";
import type { SyncReceipt } from "./syncReceipt";

export const CONFIRM_MS = 4_000;
type Tone = PillTone | "offline" | "weak";
type DisplayPill = { tone: Tone; label: string; detail: string };

/** The top status is a receipt, not a second work queue. Never infer a server
 * save from a count reaching zero: the person may have discarded the row. */
export function statusPresentation(input: {
  pill: DisplayPill;
  outboxReadState: OutboxReadState;
  allReady: boolean;
  readError: boolean;
  receipt: SyncReceipt | null;
  profileId: string | null;
  quietWhenSynced: boolean;
  now: number;
  t: TFn;
}): { visible: boolean; display: DisplayPill; receipt: boolean } {
  const { pill, outboxReadState, allReady, readError, receipt, profileId, quietWhenSynced, now, t } = input;
  if (readError) {
    return {
      visible: true,
      display: { tone: "attention", label: t("pill.cannotCheck"), detail: t("pill.cannotCheckDetail") },
      receipt: false,
    };
  }
  if (outboxReadState === "checking" || !allReady) {
    return {
      visible: true,
      display: { tone: "syncing", label: t("pill.checking"), detail: t("pill.checkingDetail") },
      receipt: false,
    };
  }
  if (
    allReady && pill.tone === "synced" && receipt?.ownerId === profileId &&
    now >= receipt.savedAt && now - receipt.savedAt < CONFIRM_MS
  ) {
    return {
      visible: true,
      display: {
        tone: "synced",
        label: t("stuck.state.sent"),
        detail: t("stuck.sentAt", { when: new Date(receipt.savedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) }),
      },
      receipt: true,
    };
  }
  return { visible: !(quietWhenSynced && allReady && pill.tone === "synced"), display: pill, receipt: false };
}

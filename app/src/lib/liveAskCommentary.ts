import { receiptStatus } from "./askReceiptGuard";
import type { FieldReceipt } from "./fieldAsk";

/**
 * What the voice is allowed to say about one Ask result. The screen is the
 * authority — receipts, choice cards, clock buttons — and this is a spoken
 * summary of it, built from the receipts' own `status`, never from the model's
 * prose about them. Choices and clock changes are never made by voice: the
 * voice says there is something to tap and the person taps it (Forge AI field
 * tools never confirm; docs/ai-field-operations.md).
 */
export interface LiveResult {
  text: string;
  receipts?: Pick<FieldReceipt, "status" | "action">[];
  buttons?: number;
  navigation?: boolean;
  artifacts?: number;
}

export type LiveTurnOutcome =
  | { kind: "answered"; reply: LiveResult }
  /** The recording could not be saved or the request not sent: kept on this phone. */
  | { kind: "kept"; keptOnPhone: boolean }
  /** Another account signed in while the turn was being saved. */
  | { kind: "other_account" }
  | { kind: "not_heard" };

const quote = (words: string) => `"${words.replace(/\s+/g, " ").trim().slice(0, 200)}"`;

export function liveCommentary(heard: string, outcome: LiveTurnOutcome): string {
  const lead = `Forge Ask result for ${quote(heard)}.`;
  const rules = "Say only what is below. Do not add facts, and do not say anything was saved, started, stopped or changed unless it says so below.";
  switch (outcome.kind) {
    case "not_heard":
      return "Forge could not match this to anything the person finished saying. Ask them to say it again. Nothing was sent or saved.";
    case "other_account":
      return `${lead} Not sent: a different person is now signed in on this phone. Nothing was saved for this request.`;
    case "kept":
      return outcome.keptOnPhone
        ? `${lead} Not sent yet. The recording is kept on this phone under "Messages not sent yet" and the person can send it from the screen. Nothing was changed in Forge.`
        : `${lead} Not sent, and this phone could not keep the recording. Tell the person to say it again or type it. Nothing was changed in Forge.`;
    case "answered": {
      const r = outcome.reply;
      const parts = [lead, rules];
      const receipts = r.receipts ?? [];
      const saved = receipts.filter((x) => receiptStatus(x) === "saved_in_forge").length;
      const choices = receipts.filter((x) => receiptStatus(x) === "needs_choice").length;
      const unchanged = receipts.length - saved - choices;
      if (saved) parts.push(`${saved} step${saved === 1 ? "" : "s"} saved in Forge.`);
      if (choices) parts.push(`${choices} step${choices === 1 ? " needs" : "s need"} the person to tap a choice on the screen. It is NOT done until they tap it.`);
      if (unchanged) parts.push(`${unchanged} step${unchanged === 1 ? "" : "s"} changed nothing.`);
      if (r.buttons) parts.push("There are clock buttons on the screen. Nothing on the clock changes unless the person taps one.");
      if (r.navigation) parts.push("A Take me there button is on the screen. Tell the person to tap it to open that screen; no job record has changed.");
      if (r.artifacts) parts.push("A report is on the screen.");
      if (!receipts.length && !r.buttons) parts.push("Nothing was saved or changed by this request.");
      parts.push(r.text.trim() ? `Answer: ${r.text.trim()}` : "There was no written answer.");
      return parts.join(" ");
    }
  }
}

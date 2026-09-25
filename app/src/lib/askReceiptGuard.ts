import type { FieldReceipt } from "./fieldAsk";

/**
 * Receipts are the only proof (crew redesign K2.5). Two pure rules:
 *
 *  - `receiptStatus` turns a database receipt into the three words the person
 *    reads: Saved in Forge / Needs your choice / Nothing changed. The model's
 *    prose never decides this; the receipt's `status` does.
 *  - `soundsDone` reads the model's prose the way an installer would and says
 *    whether it CLAIMS something was saved, started, created or logged. The
 *    Ask page shows "Nothing was saved yet" under any such reply that carries
 *    no receipt, no report card and no applied draft — so a model that says
 *    "Saved!" with nothing behind it is contradicted on screen, automatically.
 *
 * Sentence by sentence: a conditional ("once you tap Start now, the timer is
 * started") or a negation ("nothing was saved") in the same sentence is not a
 * claim. Better to warn once too often than to let "I've logged that" stand
 * over an empty conversation.
 */
export type ReceiptStatusKind = "saved_in_forge" | "needs_choice" | "nothing_changed";

export function receiptStatus(r: Pick<FieldReceipt, "status">): ReceiptStatusKind {
  switch (r.status) {
    case "done":
    case "running":
      return "saved_in_forge";
    case "needs_choice":
      return "needs_choice";
    default:
      return "nothing_changed";
  }
}

const CLAIMS: RegExp[] = [
  // "I saved it", "I've started your timer", "we have created the job"
  /\b(i|i've|i have|we|we've|we have)\s+(just\s+|now\s+|already\s+)?(saved|created|started|stopped|recorded|logged|filed|added|updated|marked|submitted|scheduled|drafted|published|clocked|finished)\b/i,
  // "unit 4 has been saved", "your timer is now running", "the log was created"
  /\b(has been|have been|is now|are now|was|were|got|is|are)\s+(saved|created|recorded|logged|filed|started|stopped|updated|marked|submitted|scheduled|drafted|published|added|running)\b/i,
  // "saved successfully", "saved to the job", "logged to Forge"
  /\b(saved|recorded|logged|filed)\s+(successfully|to (the |your )?(job|log|unit|record)|in forge)\b/i,
  /\b(all set|all done|you're all set)\b/i,
  // Spanish, first person: "guardé", "ya creé la obra", "inicié tu temporizador".
  // JS's \b is ASCII-only, so an accented ending needs letter lookarounds.
  /(?<!\p{L})(guard[ée]|cre[ée]|inici[ée]|registr[ée]|anot[ée]|agregu[ée]|actualic[ée]|marqu[ée]|envi[ée]|program[ée]|detuve|arranqu[ée])(?!\p{L})/iu,
  // Spanish, passive: "quedó guardado", "ha sido creada", "está registrado"
  /(?<!\p{L})(qued[oó]|quedan?|fue|fueron|ha sido|han sido|est[aá]n?)\s+(guardad[oa]s?|cread[oa]s?|registrad[oa]s?|iniciad[oa]s?|anotad[oa]s?|agregad[oa]s?|actualizad[oa]s?|enviad[oa]s?|programad[oa]s?|corriendo|en marcha|list[oa]s?)(?!\p{L})/iu,
  /(?<!\p{L})(todo listo|ya qued[oó])(?!\p{L})/iu,
];

/** A sentence that talks about what WOULD happen, or says nothing happened. */
const NOT_A_CLAIM: RegExp[] = [
  /\b(once|when|after|if|before|until|unless|as soon as|should)\s+(you|i|we|it|the|your)\b/i,
  /\b(will|would|could|can|may|might|shall|going to|about to|ready to|want me to|shall i|do you want|would you like)\b/i,
  // "you'll need to log it there so it is recorded": the contraction is still
  // the future, and \b never reaches "will" inside "you'll" — a live model's
  // honest instruction was flagged as a claim on 2026-09-24.
  /(?<!\p{L})(i|you|we|it|they|that|he|she|there)['’]ll(?!\p{L})/iu,
  /\b(not|nothing|nobody|never|no|hasn't|haven't|hadn't|wasn't|weren't|isn't|aren't|can't|cannot|couldn't|didn't|won't|wouldn't|don't|doesn't)\b/i,
  /\byet\b/i,
  /\?\s*$/,
  // Spanish conditionals and negations: "cuando toques", "si tocas", "no se guardó", "todavía no"
  /(?<!\p{L})(cuando|si|al|apenas|hasta que|antes de|después de|una vez que)\s+\p{L}/iu,
  /(?<!\p{L})(voy a|puedo|podr[ií]a|quieres que|te gustar[ií]a|debo|deber[ií]a|har[ée]|guardar[ée]|crear[ée]|iniciar[ée])(?!\p{L})/iu,
  /(?<!\p{L})(no|nada|nadie|nunca|todav[ií]a|a[uú]n|sin)(?!\p{L})/iu,
];

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Does this reply read as if something was saved, started or created? */
export function soundsDone(text: string): boolean {
  for (const sentence of sentences(text)) {
    if (!CLAIMS.some((re) => re.test(sentence))) continue;
    if (NOT_A_CLAIM.some((re) => re.test(sentence))) continue;
    return true;
  }
  return false;
}

export interface ReplyEvidence {
  text: string;
  receipts?: Pick<FieldReceipt, "status">[] | null;
  /** Report cards, job summaries: a read that changes nothing but IS the answer. */
  artifacts?: unknown[] | null;
  /** The reply filled a draft on the phone (daily log, lesson write-up). */
  draftApplied?: boolean;
}

/**
 * Show "Nothing was saved yet" under this reply? Yes when the words claim a
 * change and nothing on the screen proves one. A checklist alone is not
 * proof: it is kept for the conversation, not saved to the job.
 */
export function needsNothingSavedNotice(reply: ReplyEvidence): boolean {
  if (reply.receipts?.length || reply.artifacts?.length || reply.draftApplied) return false;
  return soundsDone(reply.text);
}

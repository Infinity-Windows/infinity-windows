// The submit gate: a filed install must carry its proof.
//
// Decision (owner, 2026-08-10): no partial submits. Every install that enters
// install_events arrives with a quality grade and an after photo — the grade
// feeds the leaderboard and fail-rate math, and the after photo is the
// office's evidence the opening is actually finished. Both were optional
// before, and optional in the field means sometimes-missing.
//
// The AFTER photo is the required one because it is the one that proves
// completed work. The before photo stays optional: the wall it documents is
// often already gone by the time anyone remembers to want it.

export interface SubmitProof {
  grade: number | null;
  hasAfterPhoto: boolean;
  /**
   * This unit still owes a flashing submit (lib/install/phases.ts's
   * `flashingOutstanding`).
   *
   * Added 2026-09-02 after the owner finished a BLACK22 unit that was started
   * before the flashing rule existed: the sheet let him grade it, capture the
   * after photo and tap Submit, and only the DATABASE said no — `finish_unit`
   * raised "this opening needs flashing submitted before the install is
   * filed". The screen had every fact it needed to say that first. Optional so
   * every existing caller keeps its exact wording.
   */
  flashingOwed?: boolean;
}

/** What still has to be ADDED to this capture before Submit, in reading order. */
export function submitBlockers(proof: SubmitProof): string[] {
  const missing: string[] = [];
  if (!proof.hasAfterPhoto) missing.push("an after photo");
  if (proof.grade == null) missing.push("a quality grade");
  return missing;
}

/**
 * The sentence under a disabled Submit; null when nothing blocks.
 *
 * Flashing leads, and gets its own sentence rather than joining the "add …"
 * list: it is not something you add on this screen — it is a separate pass on
 * the flash run — and it is the one the server refuses over.
 */
export function submitBlockersLine(proof: SubmitProof): string | null {
  const lines: string[] = [];
  if (proof.flashingOwed) {
    lines.push("This unit still needs flashing before the install can be filed.");
  }
  const missing = submitBlockers(proof);
  if (missing.length > 0) lines.push(`To submit, add ${missing.join(" and ")}.`);
  return lines.length === 0 ? null : lines.join(" ");
}

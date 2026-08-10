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
}

/** What still stands between this capture and Submit, in reading order. */
export function submitBlockers(proof: SubmitProof): string[] {
  const missing: string[] = [];
  if (!proof.hasAfterPhoto) missing.push("an after photo");
  if (proof.grade == null) missing.push("a quality grade");
  return missing;
}

/** One sentence for the disabled Submit button; null when nothing blocks. */
export function submitBlockersLine(proof: SubmitProof): string | null {
  const missing = submitBlockers(proof);
  if (missing.length === 0) return null;
  return `To submit, add ${missing.join(" and ")}.`;
}

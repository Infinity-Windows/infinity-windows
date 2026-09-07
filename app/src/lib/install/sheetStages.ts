/**
 * Pure helpers for the unit sheet's three-stage flow (S7 — see
 * .scratch/installer-os/installer-os-spec.md). No JSX and no hooks in this
 * file on purpose: OpeningSheet.tsx (the stage router) and the components
 * under pages/install/sheet/ own the actual rendering and every mutation;
 * this file only answers "what applies" so those decisions are testable
 * without mounting anything.
 */

export type SheetStage = "check" | "install" | "capture";

export const SHEET_STAGES: readonly SheetStage[] = ["check", "install", "capture"];

const STAGE_TITLES: Record<SheetStage, string> = {
  check: "Check",
  install: "Install",
  capture: "Capture",
};

/**
 * The stepper button's own label — "1. Check", "2. Install", "3. Capture".
 * e2e (opening-sheet.spec.ts, sessions.spec.ts) clicks the stepper by this
 * exact text, so the numbering and wording stay byte-identical to the
 * pre-split sheet.
 */
export function sheetStageLabel(stage: SheetStage): string {
  const i = SHEET_STAGES.indexOf(stage);
  return `${i + 1}. ${STAGE_TITLES[stage]}`;
}

/**
 * The stage the pinned button advances to on a tap that isn't a submit —
 * Check moves to Install, Install moves to Capture, Capture has nowhere
 * further to go (its pinned button submits instead).
 */
export function nextSheetStage(stage: SheetStage): SheetStage | null {
  const i = SHEET_STAGES.indexOf(stage);
  return SHEET_STAGES[i + 1] ?? null;
}

/**
 * Site note / complication used to be one fold shown on Check AND Capture,
 * never Install (`stage !== "install"` in the pre-split OpeningSheet.tsx —
 * the running clock is what Block exists for, and a site note mid-install
 * used to have nowhere else to be typed). Preserved exactly; only the
 * container moved into each stage's own More fold.
 */
export function showSiteNoteFold(stage: SheetStage): boolean {
  return stage !== "install";
}

/**
 * Call-for-hands + the per-window summon panel fold under Check's More
 * (the S7 mock). Install keeps its own SummonPanel inline, unfolded — it
 * already renders nothing until a summon exists or the unit clears the
 * 2-man-lift threshold, so folding it there would double-hide an already
 * quiet panel for no reason.
 */
export function showSummonFold(stage: SheetStage): boolean {
  return stage === "check";
}

/**
 * The Block flow (CONTEXT.md: a first-class exit alongside Finish) only
 * ever applied while a session's clock was running on this unit — which is
 * the Install stage and nowhere else.
 */
export function showBlockFold(stage: SheetStage): boolean {
  return stage === "install";
}

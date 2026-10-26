import type { OpeningContext } from "./openingReviewContext";

// Local Proposed-only document review, authorized 2026-10-25. Never persisted
// to production. Pin to the exact source upload and mark, not a display label.
export const reviewedProject = "fc6e7c83-a083-4cf4-9698-2524b137a166";
export const reviewedPlanset = "bd88a6cb-b7c0-421b-bf31-caee883913f0";
const reviews: Record<string, { page: number; category: string; subtype: string; configuration: string | null; note: string; panelReview?: boolean; dimensionReview?: boolean }> = {
  "2": { page: 1, category: "Window", subtype: "Fixed", configuration: "1 fixed panel", note: "Bar: fixed-window description and F-marked elevation." },
  "3": { page: 1, category: "Window", subtype: "Fixed", configuration: "1 fixed panel", note: "Bed 2: fixed-window description and F-marked elevation." },
  "14": { page: 3, category: "Window", subtype: "Fixed", configuration: "4 fixed panels", note: "Great Room: four F-marked panels. Door reference is alignment with another unit.", dimensionReview: true },
  "16": { page: 4, category: "Window", subtype: "Fixed", configuration: "4 fixed panels", note: "Dining: four F-marked panels. Door reference is alignment with another unit." },
  "23": { page: 6, category: "Door", subtype: "Sliding", configuration: null, note: "Primary Suite: sliding leaf, handle/lock and track section. Elevation shows two F panels; description says 1 panel Fixed.", panelReview: true },
  "33": { page: 8, category: "Door", subtype: "Hinged", configuration: "French · Single leaf · Inward-opening", note: "Garage: one hinged leaf, inward-opening diagram and three-point lock. French is the source term; no paired leaves." },
};
const expectedSpecs: Record<string, [string, string, number, number]> = {
  "2": ["Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)", "Fixed", 23.5, 59.5],
  "3": ["Thermal Break Aluminum Fixed Window(1 3/8\" Nail Fins)", "Fixed", 35.5, 95.5],
  "14": ["Thermal Break Aluminum Fixed Window(lines up with door on line 24)(1 3/8\" Nail Fins)", "Fixed", 191.125, 35.5],
  "16": ["Thermal Break Aluminum Fixed Window(lines up with door on line 25)(1 3/8\" Nail Fins)", "Fixed", 191.5, 23.5],
  "23": ["2 Track Thermal break Aluminum Sliding Door with Thermal Break Aluminum Fixed Window(1 panel Fixed)(New Track) (Outside View)", "Sliding/Fixed", 143.5, 107.5],
  "33": ["Thermal break Aluminum French Door(Threshold same as Picture)(1 3/8\" Nail Fins) (Outside View)", "Inward opening", 35.5, 95.5],
};
const normalized = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim().toLowerCase();
export function drawingReview(context?: OpeningContext) {
  if (!context?.spec || context.specConflict || context.opening.project_id !== reviewedProject || context.spec.project_id !== reviewedProject || context.spec.planset_id !== reviewedPlanset) return null;
  const review = reviews[context.spec.mark_code];
  // A changed description/operation/size requires a fresh review even if the
  // upload link remains the same; the fingerprint is intentionally explicit.
  const expected = expectedSpecs[context.spec.mark_code];
  if (!review || !expected || normalized(context.spec.style) !== normalized(expected[0]) || normalized(context.spec.operation) !== normalized(expected[1]) || context.spec.width_in !== expected[2] || context.spec.height_in !== expected[3]) return null;
  return { ...review, source: "HC24_-_CU.pdf", plansetId: reviewedPlanset, reviewedOn: "2026-10-25" };
}

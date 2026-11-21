import type { PDFDocumentProxy } from "pdfjs-dist";
import type { CadUnitDraft } from "../../lib/install/cadUnitPreview";
import type { PlanDrawingLabel } from "../../lib/install/matchCadPlanOpening";
import { supabase } from "../../lib/supabase";
import { drawSharpCrop } from "./drawingCrop";

/**
 * One door to the Unit Builder's AI, for both of its questions (match an
 * opening to a drawing; read one drawing's definition).
 *
 * Deployed, the review-cad-opening function holds the OpenAI key and meters
 * the spend. A dev server has neither, so it asks the same question through
 * Codex on this computer (app/scripts/localCadReview.ts).
 */
export async function askCadAi(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (import.meta.env.DEV) {
    return fetch("/__local/review-cad-opening", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(response => response.json(), () => null);
  }
  const { data, error } = await supabase.functions.invoke("review-cad-opening", { body });
  return error ? data ?? null : data;
}

/**
 * A crop for the AI: sharp enough to read a callout, small enough to send.
 * The function refuses an image over two million characters, so a dense
 * drawing is rendered again narrower rather than rejected.
 */
export async function aiCrop(pdf: PDFDocumentProxy, sheet: number, crop: CadUnitDraft["crop"], width: number) {
  let image = await drawSharpCrop(pdf, sheet, crop, width);
  for (let next = width * .7; image.length > 1_900_000 && next > 400; next *= .7) image = await drawSharpCrop(pdf, sheet, crop, next);
  return image;
}

/** The crop of the plan around one opening callout that people and the AI both look at. */
export const planCropAround = (x: number, y: number, reach = 1) => ({
  left: Math.max(0, x - .038 * reach), right: Math.min(1, x + .038 * reach),
  top: Math.max(0, y - .05 * reach), bottom: Math.min(1, y + .05 * reach),
});

export type OpeningForAi = { x: number; y: number; mark: string; sheet: number; floor: string | null; labels: PlanDrawingLabel[] };
export type AiMatch = { key: string | null; reason: string; failed?: boolean };

/** The CAD "variant" of a family drawing: A-1 beside A. */
export const variantOf = (drafts: readonly CadUnitDraft[], related: CadUnitDraft | undefined) =>
  related && drafts.find(draft => draft.label.toUpperCase().startsWith(related.label.toUpperCase() + "-"));

/** Ask the AI which CAD drawing an opening is. Never throws: a failure is an answer with no key. */
export async function reviewOpeningWithAi(args: {
  projectId: string; opening: OpeningForAi; plan: PDFDocumentProxy; cad?: PDFDocumentProxy;
  drafts: readonly CadUnitDraft[]; relatedDraft?: CadUnitDraft; familyCount?: number; planCrop?: string;
}): Promise<AiMatch> {
  const { opening, drafts, cad, relatedDraft } = args;
  try {
    const planCrop = args.planCrop ?? await aiCrop(args.plan, opening.sheet, planCropAround(opening.x, opening.y), 1400);
    const variant = variantOf(drafts, relatedDraft);
    const nearby = new Set(opening.labels.map(label => label.text.trim().replace(/^[()]|[()]$/g, "").toUpperCase()));
    // Only drawings the plan itself points at are sent as pictures: the family
    // drawing, its variant, and any whose designation is printed by the opening.
    const evidence = !cad ? [] : await Promise.all(drafts.filter(draft => draft.key === relatedDraft?.key || draft.key === variant?.key || [...nearby].some(tag =>
      tag && (draft.label.toUpperCase() === tag || draft.label.toUpperCase().startsWith(tag + " ("))))
      .slice(0, 3).map(async draft => ({ key: draft.key, image: await aiCrop(cad, draft.sheet, draft.crop, 1500) })));
    const data = await askCadAi({
      projectId: args.projectId, mark: opening.mark, floor: opening.floor, familyCount: args.familyCount,
      itemQuantity: relatedDraft?.quantity, planCrop, candidates: drafts.map(draft => ({ key: draft.key, label: draft.label })), evidence,
    });
    if (!data || data.error) {
      return { key: null, failed: true, reason: typeof data?.error === "string" ? data.error
        : "AI review is unavailable on this server. You can still compare the drawings manually." };
    }
    return {
      key: drafts.some(draft => draft.key === data.key) ? data.key as string : null,
      reason: typeof data.reason === "string" && data.reason ? data.reason : "AI could not establish a match from the supplied evidence.",
    };
  } catch {
    return { key: null, failed: true, reason: "AI review could not be completed. You can still compare the drawings manually." };
  }
}

/** Run jobs a few at a time. AI calls are slow and independent, so one at a time wastes the wait. */
export async function runPool<T>(items: readonly T[], width: number, job: (item: T) => Promise<void>, stopped: () => boolean) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length && !stopped()) await job(items[next++]);
  }));
}

/** How many AI questions are in flight at once. */
export const AI_POOL = 4;

import type { CadUnitDraft } from "./cadUnitPreview";

export interface PlanDrawingLabel {
  text: string;
  x: number;
  y: number;
  linework?: boolean;
}

export function matchPlanOpening(
  callout: { x: number; y: number },
  labels: readonly PlanDrawingLabel[],
  drafts: readonly CadUnitDraft[],
  mark?: string,
  allowItemMatch = false,
) {
  const normalizedMark = mark?.trim().replace(/^#/, "").toUpperCase();
  if (allowItemMatch && normalizedMark) {
    const family = normalizedMark.replace(/^(\d+)-[A-Z]$/, "$1");
    const numbered = drafts.filter(draft => draft.itemNumber === family);
    if (numbered.length) {
      if (numbered.length !== 1 || normalizedMark !== family) return null;
      const [draft] = numbered;
      if (drafts.some(other => other.label.toUpperCase().startsWith(draft.label.toUpperCase() + "-"))) return null;
      return { draft, tag: draft.label, linework: false, itemNumber: family };
    }
  }

  const nearest = labels.flatMap(label => {
    const tag = label.text.trim().replace(/^\(\s*|\s*\)$/g, "").toUpperCase();
    if (!/^(?:[A-Z](?:-\d+)?|CW\d+)$/.test(tag)) return [];
    const distance = Math.hypot(label.x - callout.x, label.y - callout.y);
    if (distance > (label.linework ? .035 : .026)) return [];
    const exact = drafts.filter(draft => draft.label.toUpperCase().split(/\s*&\s*/).includes(tag));
    if (!exact.length) return [];
    const variants = drafts.filter(draft => draft.label.toUpperCase().startsWith(tag + " ("));
    return [{ tag, distance: distance - (label.linework ? .008 : 0), linework: !!label.linework, candidates: [...exact, ...variants] }];
  }).sort((a, b) => a.distance - b.distance);
  const first = nearest[0];
  if (!first) return null;
  if (first.candidates.length !== 1 || nearest.some(other => other.tag !== first.tag && other.distance - first.distance < .004)) return null;
  return { draft: first.candidates[0], tag: first.tag, linework: first.linework, itemNumber: undefined };
}

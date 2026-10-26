import { drawingReview } from "./drawingReviews";
import { resolveUnitTaxonomy } from "./unitTaxonomy";
import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";
import type { OpeningContext } from "./openingReviewContext";
import { unitReporting } from "./unitReporting";

export function resolveReportingFacts(unit?: WorkUnit, context?: OpeningContext, jobId?: string, openingId = context?.opening.id) {
  const base = unitReporting(unit), warnings: string[] = [];
  const linkConflict = !!((unit?.opening_id && openingId && unit.opening_id !== openingId) || (context && jobId && context.opening.project_id !== jobId) || (unit && jobId && unit.project_id !== jobId));
  if (linkConflict) { context = undefined; warnings.push("Opening/unit job link conflicts"); }
  const review = drawingReview(context);
  const spec = context?.spec, signature = context?.opening.signature;
  const specValid = !!(spec && typeof spec.width_in === "number" && typeof spec.height_in === "number" && spec.width_in > 0 && spec.height_in > 0 && Number.isFinite(spec.width_in * spec.height_in));
  const customDimensionConflict = !!(specValid && base.area !== null && (Math.abs(spec!.width_in! - unit!.facts.width_in!) > .000001 || Math.abs(spec!.height_in! - unit!.facts.height_in!) > .000001));
  const dimensionConflict = !!review?.dimensionReview || !!context?.specConflict || customDimensionConflict;
  if (context?.specConflict) warnings.push("Multiple job specs match this opening");
  if (review?.dimensionReview) warnings.push("Drawing dimension review: #14 rough opening 192 × 24 in disagrees with elevation approximately 191½ × 35½ in; excluded from area rates");
  if (customDimensionConflict) warnings.push("Custom dimensions conflict with job spec");
  const area = linkConflict || dimensionConflict ? null : specValid ? spec!.width_in! * spec!.height_in! / 144 : base.area;
  const dimensionSource = specValid ? `Job spec ${spec!.mark_code} · ${spec!.confirmed ? "confirmed spec, not field verified" : "unconfirmed"}` : base.dimensionSource;
  const dimensionsStatus = dimensionConflict ? "conflict" : area === null ? "missing" : specValid ? spec!.confirmed ? "confirmed spec" : "unconfirmed spec" : "unverified custom";
  const classification = resolveUnitTaxonomy(linkConflict ? undefined : unit, context);
  const sourceClassification = resolveUnitTaxonomy(linkConflict ? undefined : unit, context);
  if (review) {
    for (const field of ["category", "subtype", "configuration"] as const) {
      const value = review[field];
      if (value && classification[field].status !== "conflict") {
        classification[field].value = value;
        classification[field].status = "known";
      }
      if (value) classification[field].evidence.push({ source: `Drawing review · ${review.source} p${review.page} · ${review.reviewedOn}`, raw: review.note, value });
    }
    if (review.panelReview) {
      classification.configuration.status = "conflict";
      classification.configuration.value = null;
      classification.configuration.evidence.push({ source: "Drawing elevation · p6", raw: "Two F-marked panels beside one sliding leaf; description says 1 panel Fixed", value: "2 fixed panels · 1 sliding leaf" });
      warnings.push("Panel count review: #23 elevation shows 2 fixed panels; description says 1. Configuration remains conflicting");
    }
    warnings.push("Drawing-reviewed classification · original source conflicts retained; not field verified");
  }
  for (const field of ["category", "subtype", "configuration", "system", "material"] as const) if (classification[field].status === "conflict") warnings.push(`Conflicting ${field}: ${classification[field].evidence.filter(item => item.value).map(item => `${item.value} (${item.source})`).join(" vs ")}`);
  const category = review?.category ?? (classification.category.status === "conflict" ? "Conflicting category" : classification.category.value);
  const subtype = review?.subtype ?? (classification.subtype.status === "conflict" ? "Conflicting subtype" : classification.subtype.value);
  const configuration = review?.configuration ?? (classification.configuration.status === "conflict" ? "Conflicting configuration" : classification.configuration.value);
  const system = classification.system.status === "conflict" ? "Conflicting system" : classification.system.value;
  const materialLabel = classification.material.status === "conflict" ? "Conflicting material" : classification.material.value ?? "Unknown material";
  const material = classification.material.status === "conflict" ? "conflict" : classification.material.value?.toLowerCase() ?? "unknown";
  const stories = [...new Set(signature?.tiers?.map(tier => tier.story).filter((story): story is number => typeof story === "number") ?? [])];
  let floor = linkConflict ? "unknown" : base.floor, floorLabel = linkConflict ? "Unknown floor" : base.floorLabel;
  if (!linkConflict && signature?.tiers?.length && stories.length === 1 && signature.tiers.every(tier => tier.story !== null)) {
    if (floor === "unknown") { floor = String(stories[0]); floorLabel = `Floor ${floor}`; }
    else if (floor !== String(stories[0])) { floor = "unknown"; floorLabel = "Conflicting floor"; warnings.push("Custom floor conflicts with opening signature"); }
  }
  return { ...base, area, areaBand: area === null ? "unknown" : area <= 25 ? "small" : area <= 50 ? "medium" : area <= 100 ? "large" : "xl", floor, floorLabel,
    category, subtype, configuration, system, classification, sourceClassification, review, material, materialLabel, dimensionSource, dimensionsStatus, dimensionConflict, linkConflict, warnings, context,
    width: linkConflict ? null : specValid ? spec!.width_in : unit?.facts.width_in ?? null, height: linkConflict ? null : specValid ? spec!.height_in : unit?.facts.height_in ?? null };
}
export type ReportingFacts = ReturnType<typeof resolveReportingFacts>;
export function enrichActivityRows(rows: ActivityRow[], units: WorkUnit[], contexts: Map<string, OpeningContext>) {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  return rows.map(row => {
    if (row.scope !== "Specific") return row;
    const unit = row.unitId ? byId.get(row.unitId) : undefined;
    const openingId = row.openingId ?? unit?.opening_id ?? undefined;
    const context = openingId ? contexts.get(openingId) : undefined;
    const facts = resolveReportingFacts(unit, context, row.jobId, openingId);
    const siblings = openingId ? units.filter(other => other.opening_id === openingId && other.project_id === row.jobId && other.id !== unit?.id) : [];
    if (siblings.some(other => { const otherFacts = resolveReportingFacts(other, context, row.jobId); return otherFacts.dimensionConflict || (facts.area !== null && otherFacts.area !== null && facts.area !== otherFacts.area) || (unit?.facts.width_in != null && other.facts.width_in != null && (unit.facts.width_in !== other.facts.width_in || unit.facts.height_in !== other.facts.height_in)); })) {
      facts.area = null; facts.areaBand = "unknown"; facts.dimensionConflict = true; facts.dimensionsStatus = "conflict"; facts.warnings.push("Linked unit dimensions conflict");
    }
    return { ...row, openingId, openingCode: facts.linkConflict ? row.openingCode : context?.opening.opening_code ?? row.openingCode,
      category: facts.category, subtype: facts.subtype, configuration: facts.configuration, system: facts.system, floor: facts.floor === "unknown" ? "Unknown" : facts.floor,
      material: facts.materialLabel, area: facts.area, unitFacts: facts };
  });
}

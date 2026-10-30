import type { TimeShift } from "../../lib/timeclock";
import type { WorkUnit } from "../../lib/customWork/model";
import { jobTimeReport } from "../../lib/jobTimeReport";
import type { OpeningContext } from "./openingReviewContext";
import { resolveReportingFacts } from "./reportingFacts";

/** Cost-code evidence, not a claim that every minute was direct installation. */
export const isInstallationCode = (label: string) => /^(installation|install|installing)$/i.test(label.trim());
export function comparisonSummary(jobId: string, contexts: Map<string, OpeningContext>, units: WorkUnit[], shifts: TimeShift[], installationCodes: string[]) {
  const openings = [...contexts.values()].filter(context => context.opening.project_id === jobId)
    .sort((a, b) => a.opening.opening_code.localeCompare(b.opening.opening_code, undefined, { numeric: true }));
  const inventory = openings.map(context => {
    const matching = units.filter(unit => unit.project_id === jobId && unit.opening_id === context.opening.id);
    const facts = (matching.length ? matching : [undefined]).map(unit => resolveReportingFacts(unit, context, jobId));
    const areas = new Set(facts.map(fact => fact.area));
    const conflict = facts.some(fact => fact.dimensionConflict || fact.linkConflict) || areas.size > 1;
    const areaReasons = [...new Set(facts.flatMap(fact => fact.warnings.filter(warning => /dimension|job link|multiple job specs/i.test(warning))))];
    if (areas.size > 1) areaReasons.push("Linked unit records disagree on opening area");
    if (!conflict && facts[0].area === null) areaReasons.push(context.spec ? "Linked job spec and unit facts do not provide a valid width and height" : "No usable linked job spec or unit dimensions");
    const dimensions = [...new Set([
      ...(context.spec ? [`Job spec ${context.spec.mark_code}: ${context.spec.width_in ?? "?"} × ${context.spec.height_in ?? "?"} in`] : []),
      ...(context.catalogType ? [`Catalog: ${context.catalogType.width_in ?? "?"} x ${context.catalogType.height_in ?? "?"} in`] : []),
      ...matching.map(unit => `Unit ${unit.label || unit.id}: ${unit.facts.width_in ?? "?"} × ${unit.facts.height_in ?? "?"} in`),
    ])];
    return { id: context.opening.id, code: context.opening.opening_code, category: facts[0].category,
      area: conflict ? null : facts[0].area, unconfirmed: facts.some(fact=>fact.dimensionsStatus==="unconfirmed catalog"), conflict, areaReasons, dimensions, sourceConflict: facts.some(fact => fact.sourceDimensionConflict), areaReview: facts[0].areaReview, dimensionSource: facts[0].dimensionSource };
  });
  const eligible = inventory.filter(opening => opening.area !== null);
  const area = eligible.reduce((sum, opening) => sum + opening.area!, 0);
  const jobShifts = shifts.filter(shift => shift.project_id === jobId);
  const total = jobTimeReport(jobShifts, Date.now());
  const install = jobTimeReport(jobShifts.filter(shift => installationCodes.includes(shift.cost_code_id ?? "")), Date.now());
  return { inventory, area, areaCount: eligible.length, averageArea: eligible.length ? area / eligible.length : null,
    total, install, completeArea: inventory.length > 0 && eligible.length === inventory.length };
}

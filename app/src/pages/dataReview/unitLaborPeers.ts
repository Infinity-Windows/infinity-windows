import type { WorkUnit } from "../../lib/customWork/model";
import type { ActivityRow } from "./activityRows";
import { structuralKey, type OpeningContext } from "./openingReviewContext";
import { resolveReportingFacts } from "./reportingFacts";

export type ReviewMetric = "minutes" | "area";
const quantile = (values: number[], p: number) => { const i = (values.length - 1) * p, lo = Math.floor(i); return values[lo] + (values[Math.ceil(i)] - values[lo]) * (i - lo); };
export function unitLaborReview(rows: ActivityRow[], units: WorkUnit[], metric: ReviewMetric, contexts = new Map<string, OpeningContext>()) {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const grouped = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    if (row.scope !== "Specific" || !row.unitId || row.seconds <= 0) continue;
    const unit = byId.get(row.unitId);
    const key = `${row.jobId ?? "unknown"}/${row.openingId ?? unit?.opening_id ?? row.unitId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  const samples = [...grouped].map(([key, records]) => {
    const unit = byId.get(records[0].unitId!);
    const openingId = records[0].openingId ?? unit?.opening_id;
    const context = openingId ? contexts.get(openingId) : undefined;
    const facts = records[0].unitFacts ?? resolveReportingFacts(unit, context, records[0].jobId);
    const signature = structuralKey(context);
    const problems: string[] = [], warnings: string[] = [];
    if (!openingId) problems.push("No physical opening link");
    if (context && records.some(row => row.jobId !== context.opening.project_id)) problems.push("Opening/job mismatch");
    if (unit && records.some(row => row.jobId !== unit.project_id)) problems.push("Custom unit/job mismatch");
    if (context?.opening.flag_kind) problems.push(`Opening data flagged: ${context.opening.flag_kind}`);
    if (unit?.legacy_time_present || unit?.untimed_work_present) warnings.push("Legacy or untimed work flagged; recorded labor may be partial");
    if (facts.material === "unknown") warnings.push("Material unknown; not matched by material");
    if (facts.classification && Object.values(facts.classification).some(field => field.status === "conflict")) problems.push("Classification sources conflict; excluded from peer comparisons");
    const spec = context?.spec;
    const area = facts.area;
    warnings.push(...facts.warnings);
    if (metric === "area" && area === null) problems.push("Usable, nonconflicting dimensions required for min/ft²");
    if (metric === "area" && !spec?.confirmed) warnings.push("Dimensions unverified; descriptive rate only");
    if (metric === "minutes") warnings.push("Shape comparison does not match size or material");
    const identity = signature ? `signature:${signature}` : spec ? `job-mark:${spec.project_id}/${spec.mark_code.toUpperCase()}` : null;
    if (!identity) problems.push("No stored signature or job-specific specification to match peers");
    const distinctFacts = records.map(row => byId.get(row.unitId!)).filter((value): value is WorkUnit => !!value);
    if (distinctFacts.some(other => resolveReportingFacts(other, context, records[0].jobId).area !== facts.area || other.type_label !== unit?.type_label)) warnings.push("Linked custom unit facts conflict");
    if (records.some((row, i) => records.some((other, j) => i < j && row.personId === other.personId && Date.parse(row.started) < Date.parse(other.ended) && Date.parse(other.started) < Date.parse(row.ended)))) problems.push("Overlapping records for a contributor");
    const minutes = records.reduce((sum, row) => sum + row.seconds, 0) / 60;
    const value = metric === "minutes" ? minutes : area ? minutes / area : null;
    const activitySet = [...new Set(records.map(row => row.activity))].sort().join("|");
    const sources = [...new Set(records.map(row => row.sourceTable ?? "unknown"))].sort().join("|");
    const cohort = JSON.stringify([identity, activitySet, sources]);
    return { key, records, unit, facts, minutes, value, cohort, problems, warnings, context, area, identity, flagEligible: !problems.length && !unit?.legacy_time_present && !unit?.untimed_work_present && (metric === "minutes" || !!spec?.confirmed) };
  });
  return samples.map(sample => {
    const peers = sample.problems.length ? [] : samples.filter(other => other.key !== sample.key && !other.problems.length && other.cohort === sample.cohort && other.value !== null).map(other => other.value!).sort((a, b) => a - b);
    const median = peers.length ? quantile(peers, .5) : null;
    const upper = peers.length >= 5 ? quantile(peers, .75) + 1.5 * (quantile(peers, .75) - quantile(peers, .25)) : null;
    const flagPeers = samples.filter(other => other.key !== sample.key && other.flagEligible && other.cohort === sample.cohort && other.value !== null);
    const flagReady = sample.flagEligible && flagPeers.length >= 5 && flagPeers.length === peers.length;
    const unusual = flagReady && sample.value !== null && upper !== null && median !== null && median > 0 && sample.value > upper && sample.value > median * 1.5;
    return { ...sample, peers: peers.length, median, upper, unusual, comparable: peers.length > 0, flagReady };
  }).sort((a, b) => Number(b.unusual) - Number(a.unusual) || b.minutes - a.minutes);
}

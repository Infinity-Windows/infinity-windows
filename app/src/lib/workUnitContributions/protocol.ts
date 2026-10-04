import { cloneJson, postgresInstantMicros } from "../workConfiguration/model";

/** One safe failure for malformed, oversized or mismatched private reports. */
export class UnitContributorsUnavailableError extends Error {
  constructor() {
    super("Unit contributions are unavailable. Check the current records again.");
    this.name = "UnitContributorsUnavailableError";
  }
}

export const CONTRIBUTOR_REPLY_MAX_BYTES = 1_000_000;
export const CONTRIBUTOR_MAX_PEOPLE = 200;
export const CONTRIBUTOR_MAX_ACTIVITIES = 2_000;
export const CONTRIBUTOR_MAX_EVIDENCE = 4_000;

// PostgreSQL uuid accepts any canonical 128-bit value; legacy/imported IDs need not be v4.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AMOUNT = /^(?:0|[1-9][0-9]{0,39})$/;
const INCARNATION = /^(?:0|[1-9][0-9]{0,18})$/;
const SERVER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const WORK_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REASONS = ["identity_unproven", "legacy_unmapped", "named_unlinked", "negative_interval", "open_shift", "source_unproven", "zero"] as const;
export type ContributionReason = typeof REASONS[number];
const SOURCE_KINDS = ["crew_work_record_people", "install_events", "opening_phases", "qc_checks", "work_unit_review_events"] as const;
export type NamedSourceKind = typeof SOURCE_KINDS[number];

export interface ContributorMachine { machineKind: string; knownMicros: string }
export interface ContributorActivity {
  definitionId: string; definitionVersionId: string; definitionVersion: number;
  labelEn: string; labelEs: string; retired: boolean; knownMicros: string;
  machineSubsets: ContributorMachine[];
}
export type ContributorShare = { state: "available"; numeratorMicros: string; denominatorMicros: string }
  | { state: "unavailable"; reasons: ContributionReason[] };
export interface ContributorPerson {
  profileId: string; displayName: string | null; nameState: "current" | "unavailable";
  retired: boolean | null; knownMicros: string; complete: boolean;
  completenessReasons: ContributionReason[]; includesLive: boolean;
  measurementState: "recorded" | "recorded_zero" | "unproven";
  activities: ContributorActivity[]; share: ContributorShare;
}
export interface NamedEvidence {
  sourceKind: NamedSourceKind; sourceId: string; workDate: string | null;
  recordedAt: string | null; activityLabel: string; evidenceState: "named";
}
export interface NamedContributor {
  profileId: string; displayName: string | null; nameState: "current" | "unavailable";
  retired: boolean | null; evidence: NamedEvidence[];
}
export interface UnitContributorsView {
  asOf: string; actorId: string; projectId: string; unitId: string; unitIncarnation: string;
  window: { kind: "all_retained_selected_unit"; from: null; until: string };
  unitKnownMicros: string; unitComplete: boolean; completenessReasons: ContributionReason[];
  includesLive: boolean; people: ContributorPerson[]; zeroOnly: ContributorPerson[];
  untimedParticipants: NamedContributor[];
  participantCounts: { timed: number; timingUncertain: number; untimedOnly: number; zeroOnly: number; total: number };
  unresolvedAttribution: { present: boolean; unknownMicros: null | "0"; reasons: ContributionReason[] };
}
export type UnitContributorsReply = { protocolVersion: 1; availability: "unavailable"; contributors: null }
  | { protocolVersion: 1; availability: "available"; contributors: UnitContributorsView };

const fail = (): never => { throw new UnitContributorsUnavailableError(); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
}
function bounded(value: unknown, maximum: number): unknown[] {
  return Array.isArray(value) && value.length <= maximum ? value : fail();
}
function wholeMatch(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
function id(value: unknown): string { return wholeMatch(value, UUID) ? value : fail(); }
function micros(value: unknown): bigint { return wholeMatch(value, AMOUNT) ? BigInt(value) : fail(); }
function incarnation(value: unknown): string {
  if (!wholeMatch(value, INCARNATION) || BigInt(value) > 9223372036854775807n) return fail();
  return value;
}
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : fail(); }
function integer(value: unknown, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
}
function label(value: unknown, max = 500): string {
  // PostgreSQL length(text) counts characters, while JS length counts UTF-16 units.
  return typeof value === "string" && [...value].length <= max && !value.includes("\0") ? value : fail();
}
function time(value: unknown): string {
  if (!wholeMatch(value, SERVER_TIME)) return fail();
  postgresInstantMicros(value); // Real calendar time, UTC, exactly six fraction digits.
  return value;
}
function date(value: unknown): string | null {
  if (value === null) return null;
  if (!wholeMatch(value, WORK_DATE)) return fail();
  time(`${value}T00:00:00.000000Z`);
  return value;
}
function reasons(value: unknown): ContributionReason[] {
  const rows = bounded(value, REASONS.length) as unknown[];
  let previous = "";
  for (const row of rows) {
    if (typeof row !== "string" || !REASONS.includes(row as ContributionReason) || row <= previous) return fail();
    previous = row;
  }
  return rows as ContributionReason[];
}
function sameReasons(a: readonly ContributionReason[], b: readonly ContributionReason[]): boolean {
  return a.length === b.length && a.every((reason, index) => reason === b[index]);
}
function containsAll(haystack: readonly ContributionReason[], needles: readonly ContributionReason[]): boolean {
  return needles.every(reason => haystack.includes(reason));
}
function identity(row: Record<string, unknown>, unitReasons: readonly ContributionReason[]): string {
  const profileId = id(row.profileId), name = row.displayName, retired = row.retired;
  if (row.nameState === "current") {
    if (typeof name !== "string" || !label(name).trim() || typeof retired !== "boolean") return fail();
  } else if (row.nameState === "unavailable") {
    if (name !== null || (retired !== null && typeof retired !== "boolean")) return fail();
    if (retired === null && !unitReasons.includes("identity_unproven")) return fail();
  } else return fail();
  return profileId;
}
function activity(raw: unknown): { row: ContributorActivity; total: bigint } {
  const row = exact(raw, ["definitionId", "definitionVersionId", "definitionVersion", "labelEn", "labelEs", "retired", "knownMicros", "machineSubsets"]);
  id(row.definitionId); id(row.definitionVersionId); integer(row.definitionVersion, 1, Number.MAX_SAFE_INTEGER);
  label(row.labelEn); label(row.labelEs); boolean(row.retired);
  const total = micros(row.knownMicros), machines = bounded(row.machineSubsets, 100);
  let machineTotal = 0n, previous = "";
  for (const rawMachine of machines) {
    const machine = exact(rawMachine, ["machineKind", "knownMicros"]), kind = label(machine.machineKind, 100);
    if (!kind.trim() || kind <= previous) return fail();
    previous = kind; machineTotal += micros(machine.knownMicros);
  }
  if (machineTotal > total) return fail();
  return { row: row as unknown as ContributorActivity, total };
}
function person(raw: unknown, list: "people" | "zeroOnly", unit: Record<string, unknown>, unitReasons: ContributionReason[], census: { activities: number }): { row: ContributorPerson; total: bigint } {
  const row = exact(raw, ["profileId", "displayName", "nameState", "retired", "knownMicros", "complete", "completenessReasons", "includesLive", "measurementState", "activities", "share"]);
  const profileId = identity(row, unitReasons), total = micros(row.knownMicros), complete = boolean(row.complete), live = boolean(row.includesLive);
  const ownReasons = reasons(row.completenessReasons), required = unitReasons.filter(reason => reason !== "zero");
  if (complete !== ownReasons.every(reason => reason === "zero") || complete !== unit.unitComplete
    || !containsAll(ownReasons, required)) return fail();
  if ((total === 0n) !== ownReasons.includes("zero")) return fail();
  if (live && profileId !== unit.actorId) return fail();
  const activities = bounded(row.activities, CONTRIBUTOR_MAX_ACTIVITIES - census.activities);
  census.activities += activities.length;
  let sum = 0n, priorDefinition = "", priorVersion = 0;
  const seenVersions = new Set<string>(), seenDefinitionVersions = new Set<string>();
  for (const rawActivity of activities) {
    const { row: task, total: taskTotal } = activity(rawActivity);
    const pair = `${task.definitionId}:${task.definitionVersion}`;
    if (seenVersions.has(task.definitionVersionId) || seenDefinitionVersions.has(pair)) return fail();
    seenVersions.add(task.definitionVersionId); seenDefinitionVersions.add(pair);
    if (task.definitionId < priorDefinition || (task.definitionId === priorDefinition && task.definitionVersion <= priorVersion)) return fail();
    priorDefinition = task.definitionId; priorVersion = task.definitionVersion; sum += taskTotal;
  }
  if (sum !== total) return fail();
  if (list === "people") {
    if (row.measurementState === "recorded") {
      if (total <= 0n || activities.length === 0) return fail();
    } else if (row.measurementState === "unproven") {
      if (total !== 0n || activities.length !== 0 || complete || live) return fail();
    } else return fail();
  } else if (row.measurementState !== "recorded_zero" || total !== 0n || activities.length === 0
    || !activities.every(task => micros((task as Record<string, unknown>).knownMicros) === 0n) || live || !complete) return fail();

  const share = row.share;
  if (list === "people" && unit.unitComplete && micros(unit.unitKnownMicros) > 0n) {
    const s = exact(share, ["state", "numeratorMicros", "denominatorMicros"]);
    if (s.state !== "available" || micros(s.numeratorMicros) !== total || micros(s.denominatorMicros) !== micros(unit.unitKnownMicros)) return fail();
  } else {
    const s = exact(share, ["state", "reasons"]), expected: ContributionReason[] = unitReasons.filter(reason => reason !== "zero");
    if (list === "zeroOnly" || micros(unit.unitKnownMicros) === 0n) expected.push("zero");
    expected.sort();
    if (s.state !== "unavailable" || !sameReasons(reasons(s.reasons), expected)) return fail();
  }
  return { row: row as unknown as ContributorPerson, total };
}
function evidence(raw: unknown, profileId: string, asOf: string): { row: NamedEvidence; key: string } {
  const row = exact(raw, ["sourceKind", "sourceId", "workDate", "recordedAt", "activityLabel", "evidenceState"]);
  if (!SOURCE_KINDS.includes(row.sourceKind as NamedSourceKind) || row.evidenceState !== "named") return fail();
  const kind = row.sourceKind as NamedSourceKind, source = row.sourceId;
  if (kind === "crew_work_record_people") {
    if (typeof source !== "string") return fail();
    const parts = source.split(":");
    if (parts.length !== 2 || id(parts[0]) !== parts[0] || id(parts[1]) !== profileId) return fail();
  } else id(source);
  date(row.workDate);
  if (row.recordedAt !== null && postgresInstantMicros(time(row.recordedAt)) > postgresInstantMicros(asOf)) return fail();
  label(row.activityLabel);
  return { row: row as unknown as NamedEvidence, key: `${kind}:${source}` };
}
function namedPerson(raw: unknown, unitReasons: ContributionReason[], asOf: string, census: { evidence: number; keys: Set<string> }): { row: NamedContributor; profileId: string } {
  const row = exact(raw, ["profileId", "displayName", "nameState", "retired", "evidence"]);
  const profileId = identity(row, unitReasons), entries = bounded(row.evidence, CONTRIBUTOR_MAX_EVIDENCE - census.evidence);
  if (entries.length === 0) return fail();
  census.evidence += entries.length;
  let previous = "";
  for (const raw of entries) {
    const { key } = evidence(raw, profileId, asOf);
    if (key <= previous || census.keys.has(key)) return fail();
    previous = key; census.keys.add(key);
  }
  return { row: row as unknown as NamedContributor, profileId };
}

/** Strict protocol-1 read boundary. This validates coherence but never grants
 * the caller access; actual role/source admission must precede this reply. */
export function parseUnitContributorsReply(raw: unknown, expected: {
  actorId: string; projectId: string; unitId: string; unitIncarnation?: string;
}): UnitContributorsReply {
  try {
    const actor = id(expected.actorId), project = id(expected.projectId), unitId = id(expected.unitId);
    const incarnationExpected = expected.unitIncarnation === undefined ? undefined : incarnation(expected.unitIncarnation);
    const copy = cloneJson(raw);
    if (new TextEncoder().encode(JSON.stringify(copy)).length > CONTRIBUTOR_REPLY_MAX_BYTES) return fail();
    const reply = exact(copy, ["protocolVersion", "availability", "contributors"]);
    if (reply.protocolVersion !== 1) return fail();
    if (reply.availability === "unavailable") {
      if (reply.contributors !== null) return fail();
      return copy as UnitContributorsReply;
    }
    if (reply.availability !== "available") return fail();
    const view = exact(reply.contributors, ["asOf", "actorId", "projectId", "unitId", "unitIncarnation", "window", "unitKnownMicros", "unitComplete", "completenessReasons", "includesLive", "people", "zeroOnly", "untimedParticipants", "participantCounts", "unresolvedAttribution"]);
    if (id(view.actorId) !== actor || id(view.projectId) !== project || id(view.unitId) !== unitId) return fail();
    const epoch = incarnation(view.unitIncarnation);
    if (incarnationExpected !== undefined && epoch !== incarnationExpected) return fail();
    const asOf = time(view.asOf), window = exact(view.window, ["kind", "from", "until"]);
    if (window.kind !== "all_retained_selected_unit" || window.from !== null || time(window.until) !== asOf) return fail();
    const unitMicros = micros(view.unitKnownMicros), unitComplete = boolean(view.unitComplete), live = boolean(view.includesLive);
    const unitReasons = reasons(view.completenessReasons), nonzeroReasons = unitReasons.filter(reason => reason !== "zero");
    if (unitComplete !== (nonzeroReasons.length === 0) || (unitMicros === 0n) !== unitReasons.includes("zero")) return fail();
    if (live && !unitReasons.includes("open_shift")) return fail();
    const unresolved = exact(view.unresolvedAttribution, ["present", "unknownMicros", "reasons"]);
    if (boolean(unresolved.present) !== (nonzeroReasons.length > 0)
      || !sameReasons(reasons(unresolved.reasons), nonzeroReasons)
      || unresolved.unknownMicros !== (nonzeroReasons.length ? null : "0")) return fail();

    const census = { activities: 0, evidence: 0, keys: new Set<string>() };
    const peopleRaw = bounded(view.people, CONTRIBUTOR_MAX_PEOPLE), zeroRaw = bounded(view.zeroOnly, CONTRIBUTOR_MAX_PEOPLE), namedRaw = bounded(view.untimedParticipants, CONTRIBUTOR_MAX_PEOPLE);
    if (namedRaw.length > 0 && !unitReasons.includes("named_unlinked")) return fail();
    const people = new Map<string, bigint>(), zeros = new Set<string>(), named = new Set<string>();
    let sum = 0n, previousAmount: bigint | null = null, previousId = "", peopleLive = false, timed = 0, uncertain = 0;
    for (const rawPerson of peopleRaw) {
      const { row, total } = person(rawPerson, "people", view, unitReasons, census);
      if (people.has(row.profileId) || previousAmount !== null && (total > previousAmount || total === previousAmount && row.profileId <= previousId)) return fail();
      people.set(row.profileId, total); previousAmount = total; previousId = row.profileId;
      sum += total; peopleLive ||= row.includesLive;
      if (row.measurementState === "recorded") timed++; else uncertain++;
    }
    if (sum !== unitMicros || peopleLive !== live) return fail();
    previousId = "";
    for (const rawZero of zeroRaw) {
      const { row } = person(rawZero, "zeroOnly", view, unitReasons, census);
      if (row.profileId <= previousId || people.has(row.profileId)) return fail();
      zeros.add(row.profileId); previousId = row.profileId;
    }
    previousId = "";
    for (const rawNamed of namedRaw) {
      const { profileId } = namedPerson(rawNamed, unitReasons, asOf, census);
      if (profileId <= previousId || zeros.has(profileId)) return fail();
      named.add(profileId); previousId = profileId;
    }
    if (new Set([...people.keys(), ...zeros, ...named]).size > CONTRIBUTOR_MAX_PEOPLE) return fail();
    const counts = exact(view.participantCounts, ["timed", "timingUncertain", "untimedOnly", "zeroOnly", "total"]);
    const untimedOnly = [...named].filter(profileId => !people.has(profileId)).length;
    const total = new Set([...people.keys(), ...named]).size;
    if (integer(counts.timed, 0, CONTRIBUTOR_MAX_PEOPLE) !== timed
      || integer(counts.timingUncertain, 0, CONTRIBUTOR_MAX_PEOPLE) !== uncertain
      || integer(counts.untimedOnly, 0, CONTRIBUTOR_MAX_PEOPLE) !== untimedOnly
      || integer(counts.zeroOnly, 0, CONTRIBUTOR_MAX_PEOPLE) !== zeros.size
      || integer(counts.total, 0, CONTRIBUTOR_MAX_PEOPLE) !== total) return fail();
    return copy as UnitContributorsReply;
  } catch { return fail(); }
}

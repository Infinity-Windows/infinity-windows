// Read-only fetch of the Work Data snapshot (work_data_snapshot RPC,
// 20261107000000). Supervisor/owner only, enforced server-side before any
// source table is read — see docs/work-data.md. This module does no
// classification of its own: reconcile.ts (app/src/lib/workData/reconcile.ts)
// is the pure projection over whatever this returns.
import type { Session } from "@supabase/supabase-js";
import { clientWithToken, supabase } from "../supabase";
import { isMissingFunction } from "../schemaErrors";
import { signInMark, stillSignedInAs } from "../signedIn";
import type { EvidenceClaim, EvidenceShift } from "./reconcile";

/** EvidenceShift plus the two display-only fields this screen needs that
 * reconcileShift itself never reads: who the shift belongs to, by name, and
 * why a punch's paid time is already flagged for review upstream. */
export interface WorkDataShift extends EvidenceShift {
  profileName: string;
  reviewReason: string | null;
}

export interface SnapshotUnit {
  id: string;
  label: string;
  /** Null is honest: this first slice does not independently establish a
   * taxonomy. Never derived by guessing from free text. */
  category: string | null;
  subtype: string | null;
  material: string | null;
  floor: string | null;
  widthIn: number | null;
  heightIn: number | null;
  dimensionSource: string | null;
  /** Always false in this slice — a measured-vs-estimated distinction this
   * read does not attempt to prove. See docs/work-data.md. */
  dimensionsVerified: boolean;
  complete: boolean;
  /** Always false in this slice — no qc_checks read happens here. */
  qcAccepted: boolean;
  hasUntimedEvidence: boolean;
}

/** A reported duration (or none) with no provable start/end interval —
 * opening_phases' paused-aggregate minutes, legacy install_events minutes,
 * and crew_work_records' named-only attribution. Never a guessed range. */
export interface UntimedEvidence {
  sourceId: string;
  sourceTable: string;
  profileId: string | null;
  projectId: string | null;
  unitId: string | null;
  activityId: string;
  label: string;
  /** Local calendar date (YYYY-MM-DD) this evidence is attributed to. */
  workDate: string;
  reportedSeconds: number | null;
}

export interface WorkDataSnapshot {
  schemaVersion: 1;
  /** Server clock at the moment the snapshot was assembled. */
  asOf: string;
  project: { id: string; jobCode: string; name: string };
  shifts: WorkDataShift[];
  claims: EvidenceClaim[];
  units: SnapshotUnit[];
  untimed: UntimedEvidence[];
}

export class WorkDataUnavailableError extends Error {
  constructor(message = "Work data is unavailable right now. Try again shortly.") {
    super(message);
    this.name = "WorkDataUnavailableError";
  }
}

const CLAIM_SCOPES = new Set(["general", "specific", "setup", "other"]);
const SHIFT_STATUSES = new Set(["open", "submitted", "approved", "rejected", "needs_finish", "voided"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}
function isNullableIso(v: unknown): v is string | null {
  return v === null || isIso(v);
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isNullableFiniteNumber(v: unknown): v is number | null {
  return v === null || isFiniteNumber(v);
}
function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}
function fail(reason: string): never {
  throw new WorkDataUnavailableError(`The work data snapshot was malformed (${reason}). Refresh and try again.`);
}

function validateShift(raw: unknown): WorkDataShift {
  if (typeof raw !== "object" || raw === null) fail("a shift row was not an object");
  const s = raw as Record<string, unknown>;
  if (!isNonEmptyString(s.id)) fail("a shift had no id");
  if (!isNonEmptyString(s.profileId)) fail(`shift ${String(s.id)} had no profileId`);
  if (!isNullableString(s.projectId)) fail(`shift ${String(s.id)} had an invalid projectId`);
  if (!isIso(s.startedAt)) fail(`shift ${String(s.id)} had an invalid startedAt`);
  if (!isNullableIso(s.endedAt)) fail(`shift ${String(s.id)} had an invalid endedAt`);
  if (s.endedAt !== null && Date.parse(s.endedAt as string) < Date.parse(s.startedAt as string))
    fail(`shift ${String(s.id)} ended before it started`);
  if (!isFiniteNumber(s.breakSeconds) || (s.breakSeconds as number) < 0) fail(`shift ${String(s.id)} had an invalid breakSeconds`);
  if (!isNullableIso(s.breakStartedAt)) fail(`shift ${String(s.id)} had an invalid breakStartedAt`);
  if (!SHIFT_STATUSES.has(s.status as string)) fail(`shift ${String(s.id)} had an invalid status`);
  if (!isNonEmptyString(s.profileName)) fail(`shift ${String(s.id)} had no profileName`);
  if (!isNullableString(s.reviewReason)) fail(`shift ${String(s.id)} had an invalid reviewReason`);
  return {
    id: s.id as string,
    profileId: s.profileId as string,
    profileName: s.profileName as string,
    projectId: (s.projectId as string | null) ?? null,
    startedAt: s.startedAt as string,
    endedAt: (s.endedAt as string | null) ?? null,
    breakSeconds: s.breakSeconds as number,
    breakStartedAt: (s.breakStartedAt as string | null) ?? null,
    status: s.status as string,
    reviewReason: (s.reviewReason as string | null) ?? null,
  };
}

function validateClaim(raw: unknown): EvidenceClaim {
  if (typeof raw !== "object" || raw === null) fail("a claim row was not an object");
  const c = raw as Record<string, unknown>;
  if (!isNonEmptyString(c.sourceId)) fail("a claim had no sourceId");
  if (!isNonEmptyString(c.sourceTable)) fail(`claim ${String(c.sourceId)} had no sourceTable`);
  if (c.revision !== null && (!isFiniteNumber(c.revision) || !Number.isInteger(c.revision) || c.revision < 0)) fail(`claim ${String(c.sourceId)} had an invalid revision`);
  for (const flag of ["pending", "unresolved", "rework"]) if (c[flag] !== undefined && typeof c[flag] !== "boolean") fail(`claim ${String(c.sourceId)} had an invalid ${flag}`);
  if (!isNonEmptyString(c.profileId)) fail(`claim ${String(c.sourceId)} had no profileId`);
  if (!isNullableString(c.projectId)) fail(`claim ${String(c.sourceId)} had an invalid projectId`);
  if (!isNullableString(c.shiftId)) fail(`claim ${String(c.sourceId)} had an invalid shiftId`);
  if (!isNullableString(c.unitId)) fail(`claim ${String(c.sourceId)} had an invalid unitId`);
  if (!isNonEmptyString(c.activityId)) fail(`claim ${String(c.sourceId)} had no activityId`);
  if (typeof c.label !== "string") fail(`claim ${String(c.sourceId)} had no label`);
  if (!CLAIM_SCOPES.has(c.scope as string)) fail(`claim ${String(c.sourceId)} had an invalid scope`);
  if (!isIso(c.startedAt)) fail(`claim ${String(c.sourceId)} had an invalid startedAt`);
  if (!isNullableIso(c.endedAt)) fail(`claim ${String(c.sourceId)} had an invalid endedAt`);
  if (c.endedAt !== null && Date.parse(c.endedAt as string) < Date.parse(c.startedAt as string))
    fail(`claim ${String(c.sourceId)} ended before it started`);
  return {
    sourceId: c.sourceId as string,
    sourceTable: c.sourceTable as string,
    revision: (c.revision as number | null) ?? null,
    profileId: c.profileId as string,
    projectId: (c.projectId as string | null) ?? null,
    shiftId: (c.shiftId as string | null) ?? null,
    unitId: (c.unitId as string | null) ?? null,
    activityId: c.activityId as string,
    label: c.label as string,
    scope: c.scope as EvidenceClaim["scope"],
    startedAt: c.startedAt as string,
    endedAt: (c.endedAt as string | null) ?? null,
    pending: Boolean(c.pending),
    unresolved: Boolean(c.unresolved),
    rework: Boolean(c.rework),
  };
}

function validateUnit(raw: unknown): SnapshotUnit {
  if (typeof raw !== "object" || raw === null) fail("a unit row was not an object");
  const u = raw as Record<string, unknown>;
  if (!isNonEmptyString(u.id)) fail("a unit had no id");
  if (typeof u.label !== "string") fail(`unit ${String(u.id)} had no label`);
  if (!isNullableString(u.category)) fail(`unit ${String(u.id)} had an invalid category`);
  if (!isNullableString(u.subtype)) fail(`unit ${String(u.id)} had an invalid subtype`);
  if (!isNullableString(u.material)) fail(`unit ${String(u.id)} had an invalid material`);
  if (!isNullableString(u.floor)) fail(`unit ${String(u.id)} had an invalid floor`);
  if (!isNullableFiniteNumber(u.widthIn)) fail(`unit ${String(u.id)} had an invalid widthIn`);
  if (!isNullableFiniteNumber(u.heightIn)) fail(`unit ${String(u.id)} had an invalid heightIn`);
  if (!isNullableString(u.dimensionSource)) fail(`unit ${String(u.id)} had an invalid dimensionSource`);
  if (typeof u.dimensionsVerified !== "boolean") fail(`unit ${String(u.id)} had an invalid dimensionsVerified`);
  if (typeof u.complete !== "boolean") fail(`unit ${String(u.id)} had an invalid complete`);
  if (typeof u.qcAccepted !== "boolean") fail(`unit ${String(u.id)} had an invalid qcAccepted`);
  if (typeof u.hasUntimedEvidence !== "boolean") fail(`unit ${String(u.id)} had an invalid hasUntimedEvidence`);
  return {
    id: u.id as string,
    label: u.label as string,
    category: (u.category as string | null) ?? null,
    subtype: (u.subtype as string | null) ?? null,
    material: (u.material as string | null) ?? null,
    floor: (u.floor as string | null) ?? null,
    widthIn: (u.widthIn as number | null) ?? null,
    heightIn: (u.heightIn as number | null) ?? null,
    dimensionSource: (u.dimensionSource as string | null) ?? null,
    dimensionsVerified: u.dimensionsVerified as boolean,
    complete: u.complete as boolean,
    qcAccepted: u.qcAccepted as boolean,
    hasUntimedEvidence: u.hasUntimedEvidence as boolean,
  };
}

const WORK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateUntimed(raw: unknown): UntimedEvidence {
  if (typeof raw !== "object" || raw === null) fail("an untimed row was not an object");
  const u = raw as Record<string, unknown>;
  if (!isNonEmptyString(u.sourceId)) fail("an untimed row had no sourceId");
  if (!isNonEmptyString(u.sourceTable)) fail(`untimed row ${String(u.sourceId)} had no sourceTable`);
  if (!isNullableString(u.profileId)) fail(`untimed row ${String(u.sourceId)} had an invalid profileId`);
  if (!isNullableString(u.projectId)) fail(`untimed row ${String(u.sourceId)} had an invalid projectId`);
  if (!isNullableString(u.unitId)) fail(`untimed row ${String(u.sourceId)} had an invalid unitId`);
  if (!isNonEmptyString(u.activityId)) fail(`untimed row ${String(u.sourceId)} had no activityId`);
  if (typeof u.label !== "string") fail(`untimed row ${String(u.sourceId)} had no label`);
  if (typeof u.workDate !== "string" || !WORK_DATE_RE.test(u.workDate)) fail(`untimed row ${String(u.sourceId)} had an invalid workDate`);
  const parsedDate = new Date(`${u.workDate}T12:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== u.workDate) fail(`untimed row ${String(u.sourceId)} had an impossible workDate`);
  if (!isNullableFiniteNumber(u.reportedSeconds) || (isFiniteNumber(u.reportedSeconds) && u.reportedSeconds < 0))
    fail(`untimed row ${String(u.sourceId)} had an invalid reportedSeconds`);
  return {
    sourceId: u.sourceId as string,
    sourceTable: u.sourceTable as string,
    profileId: (u.profileId as string | null) ?? null,
    projectId: (u.projectId as string | null) ?? null,
    unitId: (u.unitId as string | null) ?? null,
    activityId: u.activityId as string,
    label: u.label as string,
    workDate: u.workDate as string,
    reportedSeconds: (u.reportedSeconds as number | null) ?? null,
  };
}

/** Strict shape validation: identities, enums, finite numbers, valid
 * timestamps, the requested project, and uniqueness of every source/unit/
 * shift id. A malformed or missing RPC answer throws — it is never read as a
 * successful empty snapshot, which would read as "no work happened". */
export function validateWorkDataSnapshot(raw: unknown, expectedProjectId: string): WorkDataSnapshot {
  if (typeof raw !== "object" || raw === null) fail("the response was not an object");
  const s = raw as Record<string, unknown>;
  if (s.schemaVersion !== 1) fail(`unknown schemaVersion ${String(s.schemaVersion)}`);
  if (!isIso(s.asOf)) fail("asOf was not a valid timestamp");
  if (typeof s.project !== "object" || s.project === null) fail("project was missing");
  const project = s.project as Record<string, unknown>;
  if (!isNonEmptyString(project.id) || !isNonEmptyString(project.jobCode) || typeof project.name !== "string")
    fail("project was incomplete");
  if (project.id !== expectedProjectId) fail("the response named a different job than was requested");
  if (!Array.isArray(s.shifts)) fail("shifts was not an array");
  if (!Array.isArray(s.claims)) fail("claims was not an array");
  if (!Array.isArray(s.units)) fail("units was not an array");
  if (!Array.isArray(s.untimed)) fail("untimed was not an array");
  for (const rows of [s.shifts, s.claims, s.units, s.untimed]) if (rows.length > 10000) fail("too many evidence rows");

  const shifts = s.shifts.map(validateShift);
  const claims = s.claims.map(validateClaim);
  const units = s.units.map(validateUnit);
  const untimed = s.untimed.map(validateUntimed);

  const shiftIds = new Set<string>();
  for (const sh of shifts) {
    if (sh.projectId !== expectedProjectId) fail(`shift ${sh.id} named a different job`);
    if (shiftIds.has(sh.id)) fail(`duplicate shift id ${sh.id}`);
    shiftIds.add(sh.id);
  }
  const claimIds = new Set<string>();
  for (const c of claims) {
    if (claimIds.has(c.sourceId)) fail(`duplicate claim sourceId ${c.sourceId}`);
    claimIds.add(c.sourceId);
  }
  const shiftById = new Map(shifts.map(sh => [sh.id, sh]));
  for (const c of claims) {
    if (c.shiftId !== null && shiftById.get(c.shiftId)?.profileId !== c.profileId) fail(`claim ${c.sourceId} had an invalid payroll person link`);
    if (c.projectId !== expectedProjectId && (c.shiftId === null || !shiftIds.has(c.shiftId))) fail(`claim ${c.sourceId} named an unlinked job`);
  }
  const unitIds = new Set<string>();
  for (const u of units) {
    if (unitIds.has(u.id)) fail(`duplicate unit id ${u.id}`);
    unitIds.add(u.id);
  }
  const untimedIds = new Set<string>();
  for (const u of untimed) {
    if (untimedIds.has(u.sourceId)) fail(`duplicate untimed sourceId ${u.sourceId}`);
    untimedIds.add(u.sourceId);
    if (u.projectId !== expectedProjectId) fail(`untimed source ${u.sourceId} named another job`);
  }

  return {
    schemaVersion: 1,
    asOf: s.asOf as string,
    project: { id: project.id as string, jobCode: project.jobCode as string, name: project.name as string },
    shifts,
    claims,
    units,
    untimed,
  };
}

export interface FetchWorkDataSnapshotInput {
  projectId: string;
  /** Inclusive lower bound, ISO 8601. */
  from: string;
  /** Exclusive upper bound, ISO 8601. */
  until: string;
  signal?: AbortSignal;
}

/**
 * Fetch one job's workday reconciliation evidence. Mirrors startShift.ts's
 * session handling exactly: a signInMark taken before the (possibly slow)
 * getSession() call, re-checked after it resolves, and the RPC sent on a
 * client frozen to that one access token — never the ambient, session-
 * following client — so a late reply can never land under an account that
 * has since signed out or switched. No caching: every call is a fresh read.
 */
export async function fetchWorkDataSnapshot(input: FetchWorkDataSnapshotInput): Promise<WorkDataSnapshot> {
  const { projectId, from, until, signal } = input;
  if (!projectId) throw new Error("A job is required to read work data.");
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(until)))
    throw new Error("A valid date range is required to read work data.");
  if (Date.parse(until) <= Date.parse(from) || Date.parse(until) - Date.parse(from) > 93 * 86400000)
    throw new Error("The date range must be positive and at most 93 days.");
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const mark = signInMark();
  const who = mark.userId;
  if (!who) throw new Error("Sign in before reading work data.");

  const { data: authData, error: authError } = await supabase.auth.getSession();
  if (authError) throw authError;
  const session: Session | null = authData.session;
  if (!session || !stillSignedInAs(mark, who) || session.user?.id !== who) {
    throw new Error("Signed-in account changed. Sign in again before reading work data.");
  }

  let rpc = clientWithToken(session.access_token).rpc("work_data_snapshot", {
    p_project_id: projectId,
    p_from: from,
    p_until: until,
  });
  if (signal) rpc = rpc.abortSignal(signal);
  const { data, error } = await rpc;

  // The same account that took the mark must still be the one this answer is
  // attributed to — a slow reply arriving after a sign-out/sign-in must never
  // be read as that new sign-in's evidence.
  if (!stillSignedInAs(mark, who)) {
    throw new Error("Signed-in account changed while loading. Refresh and try again.");
  }
  if (error) {
    if (isMissingFunction(error)) throw new WorkDataUnavailableError("Work data is not available on this database yet.");
    throw error;
  }
  if (data === null || data === undefined) throw new WorkDataUnavailableError();
  return validateWorkDataSnapshot(data, projectId);
}

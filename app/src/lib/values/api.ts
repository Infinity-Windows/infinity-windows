/**
 * Monthly values review — client data access.
 *
 * Every read goes through a server RPC that enforces its own authority on
 * every call (values_my_tasks, values_my_summary, values_owner_report); none
 * of them accept a subject override. The write path (submitValuesReview) goes
 * through the offline outbox so an unfinished form can sit on the phone and
 * retry — see lib/offline/outbox.ts's enqueueValuesSubmit.
 */
import { supabase } from "../supabase";
import { isMissingFunction } from "../schemaErrors";
import type { CoreValueSlug } from "./rubric";
import {
  hashValuesSubmission,
  normalizeValuesSubmission,
  validateValuesResponse,
  VALUE_SLUGS_ASCII_SORTED,
  type ScoreEntry,
  type ValuesSubmissionResponse,
} from "./receiptContract";
export type { ScoreEntry, ValuesReceipt, ValuesSubmissionResponse } from "./receiptContract";

/**
 * Thrown by every read below when the migration hasn't shipped yet (the RPC
 * doesn't exist). Deliberately NOT a silent `[]`/`0`/`null` fallback: a
 * caller that caught that up as "truly zero" would show a crew member
 * "nothing owed" or an owner "no reviews at all" when the real answer is
 * "this build isn't live here yet" — the two are never allowed to look the
 * same. Callers that want a degrade-to-empty UI must catch this error
 * explicitly and decide that for themselves; they must never get it for free
 * from this module.
 */
export class ValuesFeatureUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The monthly values review feature is not available yet.");
    this.name = "ValuesFeatureUnavailableError";
    this.cause = cause;
  }
}

/** A successful RPC reply with an unreadable shape is not an empty result. */
export class ValuesReadMalformedError extends Error {
  readonly code = "malformed_values_read";
  constructor() {
    super("Values review information is unavailable right now.");
    this.name = "ValuesReadMalformedError";
  }
}

function readObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValuesReadMalformedError();
  return value as Record<string, unknown>;
}

function readText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValuesReadMalformedError();
  return value;
}

function readCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ValuesReadMalformedError();
  return value;
}

export type ValuesTaskStatus = "pending" | "submitted";

export interface ValuesTask {
  assignmentId: string;
  periodStart: string;
  subjectId: string;
  subjectName: string;
  reason: "dealt" | "crew" | "owner_lead" | "self" | "solo";
  solo: boolean;
  status: ValuesTaskStatus;
  submittedAt: string | null;
  /** The rubric version this assignment's period is using — pass back
   *  unchanged on submit (values_submit refuses a mismatch). */
  rubricVersion: number;
}

/** Throws `ValuesFeatureUnavailableError` before the migration ships — never
 *  a silent empty list a caller could mistake for "nothing owed". */
export async function fetchMyValuesTasks(): Promise<ValuesTask[]> {
  const { data, error } = await supabase.rpc("values_my_tasks");
  if (error) {
    if (isMissingFunction(error)) throw new ValuesFeatureUnavailableError(error);
    throw error;
  }
  if (!Array.isArray(data)) throw new ValuesReadMalformedError();
  return data.map((item: unknown) => {
    const row = readObject(item);
    if (typeof row.reason !== "string" || !["dealt", "crew", "owner_lead", "self", "solo"].includes(row.reason)
      || (row.status !== "pending" && row.status !== "submitted")
      || typeof row.solo !== "boolean"
      || (row.submitted_at !== null && typeof row.submitted_at !== "string")
      || !Number.isSafeInteger(row.rubric_version) || (row.rubric_version as number) < 1) {
      throw new ValuesReadMalformedError();
    }
    return {
      assignmentId: readText(row.assignment_id),
      periodStart: readText(row.period_start),
      subjectId: readText(row.subject_id),
      subjectName: readText(row.subject_name),
      reason: row.reason as ValuesTask["reason"],
      solo: row.solo,
      status: row.status,
      submittedAt: row.submitted_at,
      rubricVersion: row.rubric_version as number,
    };
  });
}

export async function fetchMyValuesOwedCount(): Promise<number> {
  const { data, error } = await supabase.rpc("values_my_owed_count");
  if (error) {
    if (isMissingFunction(error)) throw new ValuesFeatureUnavailableError(error);
    throw error;
  }
  return readCount(data);
}

export interface PerValueMirror {
  average: number | null;
  self: number | null;
  raters: number;
}

export interface ValuesMirror {
  byValue: Partial<Record<CoreValueSlug, PerValueMirror>>;
}

export interface FrozenQuarter {
  quarterStart: string;
  overall: number | null;
  raterCount: number;
  values: Partial<Record<CoreValueSlug, number>>;
}

export interface MyValuesSummary {
  subjectId: string;
  windowStart: string;
  windowEnd: string;
  mirror: ValuesMirror;
  allTime: ValuesMirror;
  quarters: FrozenQuarter[];
}

function toMirror(raw: unknown): ValuesMirror {
  return { byValue: readObject(raw) as ValuesMirror["byValue"] };
}

export async function fetchMyValuesSummary(): Promise<MyValuesSummary | null> {
  const { data, error } = await supabase.rpc("values_my_summary");
  if (error) {
    if (isMissingFunction(error)) throw new ValuesFeatureUnavailableError(error);
    throw error;
  }
  if (data === null) return null;
  const d = readObject(data);
  if (!Array.isArray(d.quarters)) throw new ValuesReadMalformedError();
  return {
    subjectId: readText(d.subjectId),
    windowStart: readText(d.windowStart),
    windowEnd: readText(d.windowEnd),
    mirror: toMirror(d.mirror),
    allTime: toMirror(d.allTime),
    quarters: d.quarters.map((q: unknown) => {
      const row = readObject(q);
      if (row.overall !== null && (typeof row.overall !== "number" || !Number.isFinite(row.overall))) throw new ValuesReadMalformedError();
      return {
        quarterStart: readText(row.quarterStart),
        overall: row.overall,
        raterCount: readCount(row.raterCount),
        values: readObject(row.values) as FrozenQuarter["values"],
      };
    }),
  };
}

export interface OwnerReceivedReview {
  raterName: string;
  raterClass: "owner" | "crew_leader" | "worker" | "self";
  solo: boolean;
  periodStart: string;
  comment: string | null;
  scores: Partial<Record<CoreValueSlug, number>>;
}

/** This person's own workload as a RATER this period (ADDITIVE —
 *  VALUES-OWNER-CONTRACT.md). `pending`/`canceled` mirror values_my_tasks'
 *  own lifecycle-cancellation rule: an unanswered task whose SUBJECT has
 *  since been retired/revoked is `canceled`, not `pending`. */
export interface OwnerLifecycleAsRater {
  assigned: number;
  accepted: number;
  late: number;
  pending: number;
  canceled: number;
  suspended: number;
}

/** This person's coverage as a SUBJECT this period, against the brief's
 *  two-received-reviews floor (ADDITIVE). */
export interface OwnerLifecycleCoverage {
  expectedReceived: number;
  actualReceived: number;
  missingCoverage: boolean;
}

export interface OwnerReportPerson {
  userId: string;
  name: string;
  mirror: ValuesMirror;
  owedCount: number;
  /** ADDITIVE — this person's own account state right now, re-checked on
   *  every report call, never cached. */
  suspended: boolean;
  retired: boolean;
  asRater: OwnerLifecycleAsRater;
  coverage: OwnerLifecycleCoverage;
  received: OwnerReceivedReview[];
}

export interface OwnerReport {
  periodStart: string;
  schedulerEnabled: boolean;
  people: OwnerReportPerson[];
}

/** A missing or malformed owner lifecycle is unavailable, never a zero. */
export class ValuesOwnerReportMalformedError extends Error {
  readonly code = "malformed_owner_lifecycle";
  constructor() {
    super("Owner review lifecycle is unavailable right now.");
    this.name = "ValuesOwnerReportMalformedError";
  }
}

function ownerObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValuesOwnerReportMalformedError();
  return value as Record<string, unknown>;
}

function ownerCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ValuesOwnerReportMalformedError();
  return value;
}

function ownerBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ValuesOwnerReportMalformedError();
  return value;
}

function ownerLifecycle(row: Record<string, unknown>): Pick<OwnerReportPerson, "suspended" | "retired" | "asRater" | "coverage"> {
  const rater = ownerObject(row.asRater);
  const coverage = ownerObject(row.coverage);
  const asRater: OwnerLifecycleAsRater = {
    assigned: ownerCount(rater.assigned), accepted: ownerCount(rater.accepted),
    late: ownerCount(rater.late), pending: ownerCount(rater.pending), canceled: ownerCount(rater.canceled),
    suspended: ownerCount(rater.suspended),
  };
  const parsedCoverage: OwnerLifecycleCoverage = {
    expectedReceived: ownerCount(coverage.expectedReceived),
    actualReceived: ownerCount(coverage.actualReceived),
    missingCoverage: ownerBoolean(coverage.missingCoverage),
  };
  if (asRater.assigned !== asRater.accepted + asRater.pending + asRater.canceled + asRater.suspended
    || asRater.late > asRater.accepted
    || parsedCoverage.missingCoverage !== (parsedCoverage.actualReceived < parsedCoverage.expectedReceived)) {
    throw new ValuesOwnerReportMalformedError();
  }
  return { suspended: ownerBoolean(row.suspended), retired: ownerBoolean(row.retired), asRater, coverage: parsedCoverage };
}

function ownerReceived(value: unknown): OwnerReceivedReview[] {
  if (!Array.isArray(value)) throw new ValuesReadMalformedError();
  return value.map((item: unknown) => {
    const row = readObject(item);
    if (!["owner", "crew_leader", "worker", "self"].includes(row.raterClass as string)
      || typeof row.solo !== "boolean"
      || (row.comment !== null && typeof row.comment !== "string")) throw new ValuesReadMalformedError();
    const scores = readObject(row.scores);
    for (const [slug, score] of Object.entries(scores)) {
      if (!VALUE_SLUGS_ASCII_SORTED.includes(slug as CoreValueSlug)
        || typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) {
        throw new ValuesReadMalformedError();
      }
    }
    return {
      raterName: readText(row.raterName),
      raterClass: row.raterClass as OwnerReceivedReview["raterClass"],
      solo: row.solo,
      periodStart: readText(row.periodStart),
      comment: row.comment,
      scores: scores as OwnerReceivedReview["scores"],
    };
  });
}

export async function fetchValuesOwnerReport(): Promise<OwnerReport | null> {
  const { data, error } = await supabase.rpc("values_owner_report");
  if (error) {
    if (isMissingFunction(error)) throw new ValuesFeatureUnavailableError(error);
    throw error;
  }
  if (data === null) throw new ValuesReadMalformedError();
  const d = readObject(data);
  if (typeof d.schedulerEnabled !== "boolean" || !Array.isArray(d.people)) throw new ValuesReadMalformedError();
  return {
    periodStart: readText(d.periodStart),
    schedulerEnabled: d.schedulerEnabled,
    people: d.people.map((p: unknown) => {
      const row = readObject(p);
      return {
        userId: readText(row.userId),
        name: readText(row.name),
        mirror: toMirror(row.mirror),
        owedCount: ownerCount(row.owedCount),
        ...ownerLifecycle(row),
        received: ownerReceived(row.received),
      };
    }),
  };
}

export async function setValuesSchedulerEnabled(enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_values_scheduler_enabled", { p_enabled: enabled });
  if (error) throw error;
}

/** One value's score, the wire shape values_submit expects (an ARRAY of
 *  these, not an object keyed by slug — see the migration's own comment on
 *  why: a plain object silently collapses a duplicate key before the server
 *  ever sees it). Re-exported from receiptContract — see the type-only
 *  re-export above; this helper just adapts the app's `Partial<Record<...>>`
 *  score-map shape some screens use into that array. */
export function scoresToArray(scores: Partial<Record<CoreValueSlug, number>>): ScoreEntry[] {
  return (Object.entries(scores) as [CoreValueSlug, number][]).map(([slug, score]) => ({ slug, score }));
}

/**
 * Submit a completed review directly (used when there is signal and the
 * caller wants the accepted response immediately, rather than through the
 * offline outbox). Shares the EXACT same encoding/validation as the offline
 * path (lib/offline/outboxHandlers.ts's values_submit op) by calling the
 * same receiptContract functions: normalize → hash → call the RPC with the
 * normalized payload → validate the response against that same expected
 * digest before trusting it (VALUES-RECEIPT-CONTRACT.md §6) — never a bare
 * `if (error) throw error; return data` that would accept a malformed or
 * mismatched reply as success.
 */
export async function submitValuesReviewDirect(input: {
  assignmentId: string;
  requestId: string;
  rubricVersion: number;
  scores: ScoreEntry[];
  comment: string | null;
}): Promise<ValuesSubmissionResponse> {
  const submission = normalizeValuesSubmission(input);
  const expectedDigest = await hashValuesSubmission(submission);
  const { data, error } = await supabase.rpc("values_submit", {
    p_assignment_id: submission.assignmentId,
    p_request_id: submission.requestId,
    p_rubric_version: submission.rubricVersion,
    p_scores: submission.scores,
    p_comment: submission.comment,
  });
  if (error) throw error;
  return await validateValuesResponse(data, { submission, expectedDigest });
}

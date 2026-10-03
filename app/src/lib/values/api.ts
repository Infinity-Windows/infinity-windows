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

/** Degrades to an empty list before the migration ships — never crashes. */
export async function fetchMyValuesTasks(): Promise<ValuesTask[]> {
  const { data, error } = await supabase.rpc("values_my_tasks");
  if (error) {
    if (isMissingFunction(error)) return [];
    throw error;
  }
  return (data ?? []).map((row: Record<string, unknown>) => ({
    assignmentId: row.assignment_id as string,
    periodStart: row.period_start as string,
    subjectId: row.subject_id as string,
    subjectName: (row.subject_name as string) ?? "?",
    reason: row.reason as ValuesTask["reason"],
    solo: Boolean(row.solo),
    status: row.status as ValuesTaskStatus,
    submittedAt: (row.submitted_at as string) ?? null,
    rubricVersion: Number(row.rubric_version),
  }));
}

export async function fetchMyValuesOwedCount(): Promise<number> {
  const { data, error } = await supabase.rpc("values_my_owed_count");
  if (error) {
    if (isMissingFunction(error)) return 0;
    throw error;
  }
  return Number(data ?? 0);
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
  return { byValue: (raw ?? {}) as ValuesMirror["byValue"] };
}

export async function fetchMyValuesSummary(): Promise<MyValuesSummary | null> {
  const { data, error } = await supabase.rpc("values_my_summary");
  if (error) {
    if (isMissingFunction(error)) return null;
    throw error;
  }
  if (!data) return null;
  const d = data as Record<string, unknown>;
  return {
    subjectId: d.subjectId as string,
    windowStart: d.windowStart as string,
    windowEnd: d.windowEnd as string,
    mirror: toMirror(d.mirror),
    allTime: toMirror(d.allTime),
    quarters: ((d.quarters as unknown[]) ?? []).map((q) => {
      const row = q as Record<string, unknown>;
      return {
        quarterStart: row.quarterStart as string,
        overall: row.overall == null ? null : Number(row.overall),
        raterCount: Number(row.raterCount ?? 0),
        values: (row.values ?? {}) as FrozenQuarter["values"],
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

export interface OwnerReportPerson {
  userId: string;
  name: string;
  mirror: ValuesMirror;
  owedCount: number;
  received: OwnerReceivedReview[];
}

export interface OwnerReport {
  periodStart: string;
  schedulerEnabled: boolean;
  people: OwnerReportPerson[];
}

export async function fetchValuesOwnerReport(): Promise<OwnerReport | null> {
  const { data, error } = await supabase.rpc("values_owner_report");
  if (error) {
    if (isMissingFunction(error)) return null;
    throw error;
  }
  if (!data) return null;
  const d = data as Record<string, unknown>;
  return {
    periodStart: d.periodStart as string,
    schedulerEnabled: Boolean(d.schedulerEnabled),
    people: ((d.people as unknown[]) ?? []).map((p) => {
      const row = p as Record<string, unknown>;
      return {
        userId: row.userId as string,
        name: (row.name as string) ?? "?",
        mirror: toMirror(row.mirror),
        owedCount: Number(row.owedCount ?? 0),
        received: ((row.received as unknown[]) ?? []).map((r) => {
          const rr = r as Record<string, unknown>;
          return {
            raterName: (rr.raterName as string) ?? "?",
            raterClass: rr.raterClass as OwnerReceivedReview["raterClass"],
            solo: Boolean(rr.solo),
            periodStart: rr.periodStart as string,
            comment: (rr.comment as string | null) ?? null,
            scores: (rr.scores ?? {}) as OwnerReceivedReview["scores"],
          };
        }),
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
 *  ever sees it). */
export type ScoreEntry = { slug: CoreValueSlug; score: number };

export function scoresToArray(scores: Partial<Record<CoreValueSlug, number>>): ScoreEntry[] {
  return (Object.entries(scores) as [CoreValueSlug, number][]).map(([slug, score]) => ({ slug, score }));
}

/** Immutable once accepted — never changes even after a later freeze. */
export interface ValuesReceipt {
  submissionId: string;
  assignmentId: string;
  requestId: string;
  digest: string;
  rubricVersion: number;
  acceptedAt: string;
  periodStart: string;
  quarterStart: string;
  cutoff: string;
  quarterEligibility: "eligible_before_cutoff" | "late_after_cutoff";
  /** Transient — true only when this call answered an exact replay. */
  replay: boolean;
}

/**
 * Submit a completed review directly (used when there is signal and the
 * caller wants the accepted receipt immediately). The offline path
 * (lib/offline/outbox.ts's enqueueValuesSubmit) calls the same RPC from its
 * handler with the same arguments, so both paths share one contract.
 */
export async function submitValuesReviewDirect(input: {
  assignmentId: string;
  requestId: string;
  rubricVersion: number;
  scores: ScoreEntry[];
  comment: string | null;
}): Promise<ValuesReceipt> {
  const { data, error } = await supabase.rpc("values_submit", {
    p_assignment_id: input.assignmentId,
    p_request_id: input.requestId,
    p_rubric_version: input.rubricVersion,
    p_scores: input.scores,
    p_comment: input.comment,
  });
  if (error) throw error;
  const d = data as Record<string, unknown>;
  return {
    submissionId: d.submissionId as string,
    assignmentId: d.assignmentId as string,
    requestId: d.requestId as string,
    digest: d.digest as string,
    rubricVersion: Number(d.rubricVersion),
    acceptedAt: d.acceptedAt as string,
    periodStart: d.periodStart as string,
    quarterStart: d.quarterStart as string,
    cutoff: d.cutoff as string,
    quarterEligibility: d.quarterEligibility as ValuesReceipt["quarterEligibility"],
    replay: Boolean(d.replay),
  };
}

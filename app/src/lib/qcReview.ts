// Client for the job-scoped QC review queue (qc_review_jobs / qc_review_page /
// record_qc_review_decision). Separate from lib/ops.ts's listQcQueue/setQc on
// purpose — this queue is per-job, cursor-paged, and its decision RPC carries
// an optimistic-concurrency version the old one never had.
import { supabase } from "./supabase";

export interface QcReviewJobRow {
  id: string;
  jobCode: string;
  name: string;
  newCount: number;
  callbackCount: number;
  queueCount: number;
}

export interface QcReviewJobsCursor {
  name: string;
  id: string;
}

export interface QcReviewJobsPage {
  rows: QcReviewJobRow[];
  totalCount: number;
  hasMore: boolean;
  nextCursor: QcReviewJobsCursor | null;
  /**
   * The currently chosen job's own row, resolved independently of `search`/
   * paging (`p_selected_project_id`). This is the one canonical source for a
   * restored job's code/name — never scan `rows` for it, since a search or
   * page boundary can omit the selected job entirely.
   */
  selected: QcReviewJobRow | null;
}

/**
 * `after` is opaque — whatever `qc_review_jobs` handed back as `nextCursor`
 * must go back in verbatim, never rebuilt from parts on this side.
 */
export async function fetchQcReviewJobs(args: {
  search?: string;
  limit?: number;
  after?: QcReviewJobsCursor | null;
  selectedProjectId?: string | null;
  signal?: AbortSignal;
}): Promise<QcReviewJobsPage> {
  let request = supabase.rpc("qc_review_jobs", {
    p_search: args.search ?? "",
    p_limit: args.limit ?? 50,
    p_after: args.after ?? null,
    p_selected_project_id: args.selectedProjectId ?? null,
  });
  if (args.signal) request = request.abortSignal(args.signal);
  const { data, error } = await request;
  if (error) throw error;
  return data as QcReviewJobsPage;
}

export type QcReviewFilter = "all" | "new" | "callbacks";

export interface QcReviewCursor {
  endedAt: string | null;
  id: string;
}

export interface QcReviewUnit {
  id: string;
  projectId: string;
  openingCode: string;
  label: string | null;
  assignedWindowId: string | null;
  typeCode: string | null;
  workEndedAt: string | null;
  qcStatus: string | null;
  qcNote: string | null;
  reviewerId: string | null;
  reviewedAt: string | null;
  /** Opaque optimistic-concurrency token: `"none"` or a UUID. */
  reviewVersion: string;
  matchesFilter: boolean;
}

export interface QcReviewPage {
  rows: QcReviewUnit[];
  totalCount: number;
  hasNext: boolean;
  hasPrevious: boolean;
  nextCursor: QcReviewCursor | null;
  previousCursor: QcReviewCursor | null;
  selected: QcReviewUnit | null;
}

/**
 * Only one of `after`/`before` is ever meaningful at a time — pass the other
 * as `null`, same as the RPC expects.
 */
export async function fetchQcReviewPage(args: {
  projectId: string;
  filter: QcReviewFilter;
  search?: string;
  limit?: number;
  after?: QcReviewCursor | null;
  before?: QcReviewCursor | null;
  selectedOpeningId?: string | null;
  signal?: AbortSignal;
}): Promise<QcReviewPage> {
  let request = supabase.rpc("qc_review_page", {
    p_project_id: args.projectId,
    p_filter: args.filter,
    p_search: args.search ?? "",
    p_limit: args.limit ?? 50,
    p_after: args.after ?? null,
    p_before: args.before ?? null,
    p_selected_opening_id: args.selectedOpeningId ?? null,
  });
  if (args.signal) request = request.abortSignal(args.signal);
  const { data, error } = await request;
  if (error) throw error;
  return data as QcReviewPage;
}

export type QcReviewDecisionStatus = "passed" | "callback";

/** Empty/whitespace-only notes are saved as no note at all, never `""`. */
export function normalizeQcReviewNote(note: string | null | undefined): string | null {
  const trimmed = (note ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface QcReviewDecisionArgs {
  decisionId: string;
  projectId: string;
  openingId: string;
  status: QcReviewDecisionStatus;
  expectedReviewVersion: string;
  note?: string | null;
  signal?: AbortSignal;
}

/**
 * Saves a decision. `decisionId` must stay fixed across a retry of the exact
 * same (project, opening, status, note, expectedReviewVersion) — see
 * `qcReviewDecisionKey` in qcReviewState.ts, which is what forces a NEW id
 * the moment any of those change, so a stale reuse of an old id can never be
 * mistaken by the server for a resend of the same request.
 */
export async function recordQcReviewDecision(args: QcReviewDecisionArgs): Promise<string> {
  let request = supabase.rpc("record_qc_review_decision", {
    p_decision_id: args.decisionId,
    p_project_id: args.projectId,
    p_opening_id: args.openingId,
    p_status: args.status,
    p_expected_review_version: args.expectedReviewVersion,
    p_note: normalizeQcReviewNote(args.note),
  });
  if (args.signal) request = request.abortSignal(args.signal);
  const { data, error } = await request;
  if (error) throw error;
  return data as string;
}

export type QcReviewDecisionErrorKind = "stale" | "conflict" | "unauthorized" | "unavailable" | "rejected" | "unknown";

/**
 * SQLSTATEs the decision RPC uses for the cases a retry must not paper over:
 * 40001 (another decision landed first — refuse, don't silently resend with
 * a new version), 23505 (this decisionId was already used for a DIFFERENT
 * payload), 42501 (not authorized for this opening/job), 22023 (service
 * unavailable / bad input the server refused outright).
 */
export function classifyQcReviewDecisionError(err: unknown, previouslyAmbiguous = false): QcReviewDecisionErrorKind {
  const code = err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code ?? "")
    : "";
  // Only the guarded endpoint's stale/collision result passes its immutable
  // event lookup. Auth, validation or schema failures on a later attempt say
  // nothing about whether an earlier transport failure committed.
  const message = err && typeof err === "object" && "message" in err ? String(err.message) : "";
  const guardedRefusal = (code === "40001" && message === "QC changed since you opened this unit. Refresh and review the current decision.")
    || (code === "23505" && message === "This QC request ID was already used for another decision.");
  if (previouslyAmbiguous && !guardedRefusal) return "unknown";
  switch (code) {
    case "40001": return "stale";
    case "23505": return "conflict";
    case "42501": return "unauthorized";
    case "22023": return "unavailable";
    case "22021": // Invalid text (including a NUL rejected by PostgreSQL).
    case "22P02": // Invalid typed input, before a transaction can commit.
    case "PGRST202": // Guarded function absent from the schema cache.
    case "42883": return "rejected";
    default: return "unknown";
  }
}

// Pure state helpers for the QC review flow: URL <-> view-state, per-real-
// viewer session restore, and the decision-id binding that keeps a retry of
// the same save from drifting into a different one. No React here on
// purpose — QcReviewFlow.tsx is the only thing that touches window/location.
import type { QcReviewCursor, QcReviewDecisionStatus, QcReviewFilter } from "./qcReview";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEARCH_LEN = 200;
const QC_REVIEW_FILTERS: readonly QcReviewFilter[] = ["all", "new", "callbacks"];

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isQcReviewFilter(value: unknown): value is QcReviewFilter {
  return typeof value === "string" && (QC_REVIEW_FILTERS as readonly string[]).includes(value);
}

function sanitizeUuid(value: unknown): string | null {
  return isUuid(value) ? value.toLowerCase() : null;
}

function sanitizeFilter(value: unknown): QcReviewFilter {
  return isQcReviewFilter(value) ? value : "all";
}

function sanitizeSearch(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_SEARCH_LEN) : "";
}

/** A corrupted or hand-edited cursor must fail closed (treated as "no cursor"), never throw. */
export function sanitizeQcReviewCursor(value: unknown): QcReviewCursor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { endedAt?: unknown; id?: unknown };
  if (!isUuid(candidate.id)) return null;
  if (candidate.endedAt !== null && typeof candidate.endedAt !== "string") return null;
  if (typeof candidate.endedAt === "string" && !Number.isFinite(Date.parse(candidate.endedAt))) return null;
  return { endedAt: candidate.endedAt ?? null, id: candidate.id.toLowerCase() };
}

/** Base64url so the cursor can live in a URL query param without escaping. */
export function encodeQcReviewCursorParam(cursor: QcReviewCursor | null): string | null {
  const sanitized = sanitizeQcReviewCursor(cursor);
  if (!sanitized) return null;
  try {
    const json = JSON.stringify(sanitized);
    const base64 = typeof window === "undefined" ? Buffer.from(json, "utf8").toString("base64") : window.btoa(json);
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

export function decodeQcReviewCursorParam(raw: string | null | undefined): QcReviewCursor | null {
  if (!raw || raw.length > 500) return null;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = typeof window === "undefined"
      ? Buffer.from(padded + pad, "base64").toString("utf8")
      : window.atob(padded + pad);
    return sanitizeQcReviewCursor(JSON.parse(json));
  } catch {
    return null;
  }
}

export interface QcReviewViewState {
  job: string | null;
  filter: QcReviewFilter;
  search: string;
  sel: string | null;
  after: QcReviewCursor | null;
  before: QcReviewCursor | null;
}

export const DEFAULT_QC_REVIEW_VIEW: QcReviewViewState = {
  job: null, filter: "all", search: "", sel: null, after: null, before: null,
};

const PARAM_JOB = "job", PARAM_FILTER = "filter", PARAM_SEARCH = "q", PARAM_SEL = "sel",
  PARAM_AFTER = "after", PARAM_BEFORE = "before";

/** Reads the view from the URL. Invalid/corrupted values quietly fall back to defaults. */
export function parseQcReviewUrlState(params: URLSearchParams): QcReviewViewState {
  const after = decodeQcReviewCursorParam(params.get(PARAM_AFTER));
  // Only one of after/before is ever meaningful — a URL carrying both (hand-
  // edited, or a stale bookmark) keeps `after` and drops `before`.
  const before = after ? null : decodeQcReviewCursorParam(params.get(PARAM_BEFORE));
  return {
    job: sanitizeUuid(params.get(PARAM_JOB)),
    filter: sanitizeFilter(params.get(PARAM_FILTER)),
    search: sanitizeSearch(params.get(PARAM_SEARCH)),
    sel: sanitizeUuid(params.get(PARAM_SEL)),
    after,
    before,
  };
}

/** Writes the view into a fresh set of params, dropping keys this flow owns that are at their default. */
export function buildQcReviewSearchParams(state: QcReviewViewState, existing?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(existing);
  [PARAM_JOB, PARAM_FILTER, PARAM_SEARCH, PARAM_SEL, PARAM_AFTER, PARAM_BEFORE].forEach((key) => params.delete(key));
  if (state.job) params.set(PARAM_JOB, state.job);
  if (state.filter !== "all") params.set(PARAM_FILTER, state.filter);
  if (state.search) params.set(PARAM_SEARCH, state.search);
  if (state.sel) params.set(PARAM_SEL, state.sel);
  const afterParam = encodeQcReviewCursorParam(state.after);
  if (afterParam) {
    params.set(PARAM_AFTER, afterParam);
  } else {
    const beforeParam = encodeQcReviewCursorParam(state.before);
    if (beforeParam) params.set(PARAM_BEFORE, beforeParam);
  }
  return params;
}

function sanitizeQcReviewViewState(value: unknown): QcReviewViewState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const after = sanitizeQcReviewCursor(candidate.after);
  return {
    job: sanitizeUuid(candidate.job),
    filter: sanitizeFilter(candidate.filter),
    search: sanitizeSearch(candidate.search),
    sel: sanitizeUuid(candidate.sel),
    after,
    before: after ? null : sanitizeQcReviewCursor(candidate.before),
  };
}

function qcReviewStorageKey(viewerId: string): string {
  return `qcReview:v1:${viewerId}`;
}

/**
 * Session-scoped restore, keyed by the REAL signed-in viewer (never a
 * person-preview id) so a shared device can't hand one account's restored
 * job/filter/search to another that signs in after it. A missing/corrupted
 * entry reads as "nothing to restore", never a thrown error.
 */
export function readQcReviewSession(viewerId: string | null | undefined): QcReviewViewState | null {
  if (!viewerId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(qcReviewStorageKey(viewerId));
    if (!raw) return null;
    return sanitizeQcReviewViewState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeQcReviewSession(viewerId: string | null | undefined, state: QcReviewViewState): void {
  if (!viewerId || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(qcReviewStorageKey(viewerId), JSON.stringify(state));
  } catch {
    // Storage full or blocked (private mode): the view still works this
    // session, it just won't restore on the next one.
  }
}

export function clearQcReviewSession(viewerId: string | null | undefined): void {
  if (!viewerId || typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(qcReviewStorageKey(viewerId));
  } catch {
    // Nothing to clean up if storage can't be touched at all.
  }
}

/**
 * The tuple a saved decision is bound to. Any change to it — a different
 * note, a refreshed `reviewVersion` after a stale retry — must mint a new
 * decisionId; reusing the old one for a different payload is exactly the
 * `23505` "conflicting reuse" the server refuses.
 */
export function qcReviewDecisionKey(args: {
  projectId: string;
  openingId: string;
  status: QcReviewDecisionStatus;
  note: string | null;
  expectedReviewVersion: string;
}): string {
  return [args.projectId, args.openingId, args.status, args.expectedReviewVersion, args.note ?? ""].join("\u0000");
}

export interface QcReviewDecisionIds {
  /** Same key in, same id out — until `forget` (success) or `clear` (reset) drops it. */
  idFor(key: string): string;
  forget(key: string): void;
  clear(): void;
}

export function createQcReviewDecisionIds(): QcReviewDecisionIds {
  const ids = new Map<string, string>();
  return {
    idFor(key: string): string {
      let id = ids.get(key);
      if (!id) {
        id = crypto.randomUUID();
        ids.set(key, id);
      }
      return id;
    },
    forget(key: string): void {
      ids.delete(key);
    },
    clear(): void {
      ids.clear();
    },
  };
}

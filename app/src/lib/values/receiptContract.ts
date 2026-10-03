/**
 * Monthly values review — shared receipt/digest contract, v1.
 *
 * The EXACT encoding decided in
 * ../../../../../outputs/Crew-Goals-Values-Build-2026-10-03/VALUES-RECEIPT-CONTRACT.md
 * (Codex/Astra, 2026-10-03) and implemented independently in SQL by
 * `values_submit()` (supabase/migrations/20261106000000_monthly_values_reviews.sql).
 * This file is the ONE browser-side place that encoding lives — the offline
 * outbox, the direct-submit path and any future caller all import it rather
 * than each growing their own copy that can quietly drift from the server's.
 *
 * Deliberately tiny and dependency-free: no import of `./rubric` (which
 * carries the full English rubric text) or anything else app-specific — the
 * eight slugs below are repeated as a literal, ASCII-sorted constant rather
 * than imported, because this module's only two jobs are byte-exact
 * encoding and byte-exact response validation. Keep the two slug lists (this
 * file's and `./rubric`'s `VALUE_SLUGS`) the same EIGHT names; order may
 * differ (this file sorts ASCII, `rubric.ts` is display order) and both are
 * exercised against each other in `rubric.test.ts` / this file's own test.
 */

/** The one encoding version this file knows how to produce or check. */
export const VALUES_SUBMIT_ENCODING_VERSION = "forge-values-submit/v1" as const;

/** ASCII-sorted — the exact digest line order (contract §2), not display order. */
export const VALUE_SLUGS_ASCII_SORTED = [
  "fullsend",
  "growth",
  "integrity",
  "ownership",
  "safety",
  "sincerity",
  "strategic",
  "tribe",
] as const;

export type ValuesSlug = (typeof VALUE_SLUGS_ASCII_SORTED)[number];

const KNOWN_SLUGS: ReadonlySet<string> = new Set(VALUE_SLUGS_ASCII_SORTED);

export type ScoreEntry = { slug: ValuesSlug; score: number };

/** A recognizable, catchable error code — never a silent `[]`/`0`/`null`/`false`. */
export type ValuesContractErrorCode =
  | "invalid_assignment_id"
  | "invalid_request_id"
  | "invalid_rubric_version"
  | "invalid_scores_shape"
  | "unknown_score_slug"
  | "duplicate_score_slug"
  | "missing_score_slug"
  | "invalid_score_value"
  | "invalid_comment"
  | "malformed_response"
  | "digest_mismatch"
  | "replay_field_mismatch";

export class ValuesContractError extends Error {
  readonly code: ValuesContractErrorCode;
  constructor(code: ValuesContractErrorCode, message: string) {
    super(message);
    this.name = "ValuesContractError";
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeUuid(raw: string, code: ValuesContractErrorCode, label: string): string {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new ValuesContractError(code, `${label} is not a canonical UUID.`);
  }
  return raw.toLowerCase();
}

/** ASCII-space trim only — never `.trim()`/`.trimStart()`/`.trimEnd()`/`\s` (contract §1/§4). */
function trimAsciiSpaces(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) === 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) === 0x20) end--;
  return s.slice(start, end);
}

function assertNoForbiddenCodeUnits(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) {
      throw new ValuesContractError("invalid_comment", "A comment cannot contain a NUL character.");
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ValuesContractError("invalid_comment", "A comment cannot contain an unpaired surrogate.");
      }
      i++; // consumed the matched low surrogate too
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new ValuesContractError("invalid_comment", "A comment cannot contain an unpaired surrogate.");
    }
  }
}

const MAX_COMMENT_CODE_POINTS = 2000;

/** Null stays null; empty-after-trim becomes null (contract §1). */
function normalizeComment(raw: string | null): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new ValuesContractError("invalid_comment", "A comment must be a string or null.");
  }
  assertNoForbiddenCodeUnits(raw);
  const trimmed = trimAsciiSpaces(raw);
  if (trimmed.length === 0) return null;
  if ([...trimmed].length > MAX_COMMENT_CODE_POINTS) {
    throw new ValuesContractError("invalid_comment", `A comment can be at most ${MAX_COMMENT_CODE_POINTS} characters.`);
  }
  return trimmed;
}

export interface RawValuesSubmissionInput {
  assignmentId: string;
  requestId: string;
  rubricVersion: number;
  scores: readonly { slug: string; score: unknown }[];
  comment: string | null;
}

/** The normalized, persist-before-queueing payload (contract §1/§4). */
export interface SavedValuesSubmission {
  encodingVersion: typeof VALUES_SUBMIT_ENCODING_VERSION;
  assignmentId: string;
  requestId: string;
  rubricVersion: number;
  /** Exactly eight entries, ASCII-slug order — order is not meaningful, this
   *  is just a deterministic, stable shape for a saved/retried payload. */
  scores: readonly ScoreEntry[];
  comment: string | null;
}

/**
 * Validate and normalize a submission BEFORE hashing or queueing it
 * (contract §1). Throws `ValuesContractError` on any invalid shape — never
 * returns a partially-normalized or silently-coerced value.
 */
export function normalizeValuesSubmission(input: RawValuesSubmissionInput): SavedValuesSubmission {
  const assignmentId = normalizeUuid(input.assignmentId, "invalid_assignment_id", "assignmentId");
  const requestId = normalizeUuid(input.requestId, "invalid_request_id", "requestId");

  if (!Number.isInteger(input.rubricVersion) || input.rubricVersion < 1 || input.rubricVersion > 2147483647) {
    throw new ValuesContractError("invalid_rubric_version", "rubricVersion must be a positive 32-bit integer.");
  }

  if (!Array.isArray(input.scores) || input.scores.length !== 8) {
    throw new ValuesContractError("invalid_scores_shape", "scores must be an array of exactly eight entries.");
  }
  const seen = new Set<string>();
  const bySlug = new Map<ValuesSlug, number>();
  for (const entry of input.scores) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as { slug?: unknown }).slug !== "string"
    ) {
      throw new ValuesContractError("invalid_scores_shape", "Each score entry needs a slug and a score.");
    }
    // Exactly {slug, score} — no extra properties smuggled onto a score
    // entry (contract §1: "each object has exactly the keys slug and score").
    const keys = Object.keys(entry as object);
    if (keys.length !== 2 || !keys.includes("slug") || !keys.includes("score")) {
      throw new ValuesContractError("invalid_scores_shape", "Each score entry must have exactly the keys slug and score.");
    }
    const slug = (entry as { slug: string }).slug;
    if (!KNOWN_SLUGS.has(slug)) {
      throw new ValuesContractError("unknown_score_slug", `Unknown value "${slug}".`);
    }
    if (seen.has(slug)) {
      throw new ValuesContractError("duplicate_score_slug", `Value "${slug}" was scored twice.`);
    }
    seen.add(slug);
    const score = (entry as { score: unknown }).score;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 10) {
      throw new ValuesContractError("invalid_score_value", `Value "${slug}" needs a whole-number score from 1 to 10.`);
    }
    bySlug.set(slug as ValuesSlug, score);
  }
  for (const slug of VALUE_SLUGS_ASCII_SORTED) {
    if (!bySlug.has(slug)) {
      throw new ValuesContractError("missing_score_slug", `Value "${slug}" is missing a score.`);
    }
  }

  const comment = normalizeComment(input.comment);

  return {
    encodingVersion: VALUES_SUBMIT_ENCODING_VERSION,
    assignmentId,
    requestId,
    rubricVersion: input.rubricVersion,
    scores: VALUE_SLUGS_ASCII_SORTED.map((slug) => ({ slug, score: bySlug.get(slug)! })),
    comment,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The exact canonical text `hashValuesSubmission` hashes (contract §2). */
export function canonicalValuesSubmissionText(saved: SavedValuesSubmission): string {
  const utf8 = new TextEncoder();
  const scoreBySlug = new Map(saved.scores.map((s) => [s.slug, s.score] as const));
  const scoreLines = VALUE_SLUGS_ASCII_SORTED.map((slug) => `${slug}=${scoreBySlug.get(slug)}\n`).join("");
  const token =
    saved.comment === null ? "null" : `hex:${bytesToHex(utf8.encode(saved.comment))}`;
  return (
    `${VALUES_SUBMIT_ENCODING_VERSION}\n` +
    `assignment=${saved.assignmentId}\n` +
    `request=${saved.requestId}\n` +
    `rubric=${saved.rubricVersion}\n` +
    scoreLines +
    `comment=${token}\n`
  );
}

/** SHA-256 hex of the canonical text (contract §2/§4) — matches the SQL side exactly. */
export async function hashValuesSubmission(saved: SavedValuesSubmission): Promise<string> {
  const canonical = canonicalValuesSubmissionText(saved);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(digest));
}

export type QuarterEligibility = "eligible_before_cutoff" | "late_after_cutoff";

/** Immutable once accepted — never changes even after a later freeze (contract §5). */
export interface ValuesReceipt {
  encodingVersion: string;
  submissionId: string;
  assignmentId: string;
  requestId: string;
  rubricVersion: number;
  digest: string;
  acceptedAt: string;
  quarterStart: string;
  cutoffAt: string;
  quarterEligibility: QuarterEligibility;
}

export interface ValuesSubmissionResponse {
  receipt: ValuesReceipt;
  /** Transient transport metadata — true only when this call answered an exact replay. */
  replay: boolean;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** A canonical, lowercase UUID — the exact shape the server persists/returns. */
function isCanonicalUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v) && v === v.toLowerCase();
}

/** A real, parseable timestamp — rejects garbage like `"not-a-date"` or `""`
 *  that `new Date()` would otherwise silently accept as NaN only on `.getTime()`. */
function isIsoTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms);
}

const QUARTER_START_RE = /^(\d{4})-(\d{2})-01$/;

/** A genuine calendar-quarter start: YYYY-MM-01 with month in {01,04,07,10}. */
function isQuarterStartDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = QUARTER_START_RE.exec(v);
  if (!m) return false;
  return m[2] === "01" || m[2] === "04" || m[2] === "07" || m[2] === "10";
}

/**
 * Validate an RPC response shape against the SAVED entry (never the current
 * form state) and the digest expected at queue time (contract §6). Throws
 * `ValuesContractError` on any mismatch or malformed field — callers must
 * treat that as "keep the entry queued/conflict", never as success.
 */
export async function validateValuesResponse(
  raw: unknown,
  savedExpected: { submission: SavedValuesSubmission; expectedDigest: string },
): Promise<ValuesSubmissionResponse> {
  if (raw === null || typeof raw !== "object") {
    throw new ValuesContractError("malformed_response", "The response was not an object.");
  }
  const r = raw as Record<string, unknown>;
  const receiptRaw = r.receipt;
  if (receiptRaw === null || typeof receiptRaw !== "object") {
    throw new ValuesContractError("malformed_response", "The response has no receipt object.");
  }
  const rc = receiptRaw as Record<string, unknown>;
  const replay = r.replay;
  if (typeof replay !== "boolean") {
    throw new ValuesContractError("malformed_response", "The response's replay flag is missing or not a boolean.");
  }

  const { submission: saved, expectedDigest } = savedExpected;

  if (rc.encodingVersion !== saved.encodingVersion) {
    throw new ValuesContractError("replay_field_mismatch", "The receipt's encoding version does not match the saved entry.");
  }
  if (rc.assignmentId !== saved.assignmentId) {
    throw new ValuesContractError("replay_field_mismatch", "The receipt's assignment id does not match the saved entry.");
  }
  if (rc.requestId !== saved.requestId) {
    throw new ValuesContractError("replay_field_mismatch", "The receipt's request id does not match the saved entry.");
  }
  if (rc.rubricVersion !== saved.rubricVersion) {
    throw new ValuesContractError("replay_field_mismatch", "The receipt's rubric version does not match the saved entry.");
  }

  const recomputedDigest = await hashValuesSubmission(saved);
  if (
    !isNonEmptyString(rc.digest) ||
    rc.digest !== recomputedDigest ||
    rc.digest !== expectedDigest
  ) {
    throw new ValuesContractError("digest_mismatch", "The receipt's digest does not match the saved payload.");
  }

  if (!isCanonicalUuid(rc.submissionId)) {
    throw new ValuesContractError("malformed_response", "The receipt's submission id is not a canonical UUID.");
  }
  if (!isIsoTimestamp(rc.acceptedAt) || !isIsoTimestamp(rc.cutoffAt)) {
    throw new ValuesContractError("malformed_response", "The receipt's acceptedAt/cutoffAt is not a real timestamp.");
  }
  if (!isQuarterStartDate(rc.quarterStart)) {
    throw new ValuesContractError("malformed_response", "The receipt's quarterStart is not a genuine calendar-quarter start date.");
  }
  if (rc.quarterEligibility !== "eligible_before_cutoff" && rc.quarterEligibility !== "late_after_cutoff") {
    throw new ValuesContractError("malformed_response", "The receipt has an unknown eligibility state.");
  }
  // Eligibility must actually agree with the two timestamps it is derived
  // from (contract §5: "eligible_before_cutoff | late_after_cutoff"), not
  // merely be one of the two known strings — a server bug or a tampered
  // response naming the wrong side of the cutoff must not be accepted as a
  // trustworthy receipt.
  const accepted = Date.parse(rc.acceptedAt as string);
  const cutoff = Date.parse(rc.cutoffAt as string);
  const shouldBeLate = accepted >= cutoff;
  if (shouldBeLate && rc.quarterEligibility !== "late_after_cutoff") {
    throw new ValuesContractError("malformed_response", "acceptedAt is at or after cutoffAt but eligibility says eligible_before_cutoff.");
  }
  if (!shouldBeLate && rc.quarterEligibility !== "eligible_before_cutoff") {
    throw new ValuesContractError("malformed_response", "acceptedAt is before cutoffAt but eligibility says late_after_cutoff.");
  }

  return {
    receipt: {
      encodingVersion: rc.encodingVersion as string,
      submissionId: rc.submissionId as string,
      assignmentId: rc.assignmentId as string,
      requestId: rc.requestId as string,
      rubricVersion: rc.rubricVersion as number,
      digest: rc.digest as string,
      acceptedAt: rc.acceptedAt as string,
      quarterStart: rc.quarterStart as string,
      cutoffAt: rc.cutoffAt as string,
      quarterEligibility: rc.quarterEligibility as QuarterEligibility,
    },
    replay,
  };
}

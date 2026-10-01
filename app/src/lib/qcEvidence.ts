// QC unit evidence reader (Astra's design receipt, 2026-10-01): a dedicated
// read keyed by expected project id + opening UUID, never a job/type-wide
// fallback. Attachment rows are candidates, not an association rule — every
// populated target is checked by `classifyAttachment` before anything is
// signed. See qcEvidenceTypes.ts (Codex-owned) for the shapes this returns.

import { supabase } from "./supabase";
import { getOpening } from "./install/api";
import { isMissingColumn } from "./schemaErrors";
import { MEMO_TOPICS } from "./install/types";
import type {
  QcEvidenceEvent,
  QcEvidenceMedia,
  QcEvidenceProblem,
  QcEvidenceSource,
  QcUnitEvidence,
} from "./qcEvidenceTypes";

const ROW_CAP = 500;
const EVENT_ID_BATCH = 150;

// --------------------------------------------------------------- predicates

/** The columns this reader needs off a candidate `attachments` row. No column
 * here is invented — every one was confirmed against the migrations that
 * built up the table (20260715000000 through 20260989000000). */
export interface AttachmentCandidate {
  id: string;
  project_id: string | null;
  project_opening_id: string | null;
  install_event_id: string | null;
  window_id: string | null;
  package_id: string | null;
  service_case_id: string | null;
  kind: string;
  storage_path: string;
  created_at: string | null;
  taken_at: string | null;
  caption: string | null;
  transcript: string | null;
  deleted_at: string | null;
}

export interface ClassifyContext {
  openingId: string;
  expectedProjectId: string;
  /** Canonical install_events on this opening: event id -> its window_id. */
  eventWindowById: ReadonlyMap<string, string | null>;
  /** Current assigned window + every canonical event's window, this opening. */
  knownWindowIds: ReadonlySet<string>;
  currentAssignedWindowId: string | null;
  /** Astra's ambiguity check already ran and said the legacy slice is safe. */
  legacyAllowed: boolean;
}

export interface AttachmentClassification {
  source: QcEvidenceSource;
  eventId: string | null;
}

/**
 * Astra's predicate, applied to every candidate row regardless of which
 * query turned it up: an OR query is retrieval, not the association rule.
 * Returns null for anything that must not be signed as this unit's evidence.
 */
export function classifyAttachment(
  row: AttachmentCandidate,
  ctx: ClassifyContext,
): AttachmentClassification | null {
  if (row.kind !== "photo" && row.kind !== "voice_memo") return null;
  if (row.deleted_at) return null;
  if (row.package_id != null || row.service_case_id != null) return null;
  // An explicit foreign project/opening is a conflict even when another
  // target matches — never let an OR branch override it.
  if (row.project_id != null && row.project_id !== ctx.expectedProjectId) return null;
  if (row.project_opening_id != null && row.project_opening_id !== ctx.openingId) return null;

  if (row.install_event_id != null) {
    if (!ctx.eventWindowById.has(row.install_event_id)) return null;
    const eventWindowId = ctx.eventWindowById.get(row.install_event_id) ?? null;
    if (row.window_id != null) {
      if (eventWindowId != null) {
        // A historical event's own window_id is authority — never rejected
        // for disagreeing with the opening's CURRENT assignment.
        if (row.window_id !== eventWindowId) return null;
      } else if (!ctx.knownWindowIds.has(row.window_id)) {
        return null;
      }
    }
    return { source: "install", eventId: row.install_event_id };
  }

  if (row.project_opening_id === ctx.openingId) {
    if (row.window_id != null && !ctx.knownWindowIds.has(row.window_id)) return null;
    return { source: "unit", eventId: null };
  }

  // Legacy window-only: no event, no opening target. Strict initial rule
  // (Astra): the row's OWN project_id must equal the expected job — a null
  // project_id window-only row cannot establish its historical job from
  // today's windows.project_id, so it is left out as ambiguous.
  if (
    ctx.legacyAllowed &&
    ctx.currentAssignedWindowId != null &&
    row.window_id === ctx.currentAssignedWindowId &&
    row.project_id === ctx.expectedProjectId
  ) {
    return { source: "assigned_window", eventId: null };
  }

  return null;
}

function sameTargets(a: AttachmentCandidate, b: AttachmentCandidate): boolean {
  return (
    a.project_id === b.project_id &&
    a.project_opening_id === b.project_opening_id &&
    a.install_event_id === b.install_event_id &&
    a.window_id === b.window_id &&
    a.package_id === b.package_id &&
    a.service_case_id === b.service_case_id &&
    a.storage_path === b.storage_path &&
    a.kind === b.kind &&
    a.deleted_at === b.deleted_at
  );
}

/** Dedupe the candidate union by attachment ID. Disagreeing duplicate reads
 * of the same id are dropped rather than merged — a refetch, not a guess. */
export function dedupeAttachmentCandidates(
  rows: readonly AttachmentCandidate[],
): { rows: AttachmentCandidate[]; conflictIds: string[] } {
  const byId = new Map<string, AttachmentCandidate>();
  const conflictIds = new Set<string>();
  for (const row of rows) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, row);
      continue;
    }
    if (!sameTargets(existing, row)) conflictIds.add(row.id);
  }
  return {
    rows: [...byId.values()].filter((r) => !conflictIds.has(r.id)),
    conflictIds: [...conflictIds],
  };
}

export interface LegacyAmbiguityInput {
  currentAssignedWindowId: string | null;
  expectedProjectId: string;
  windowProjectIdKnown: boolean;
  windowProjectId: string | null;
  /** Other LIVE openings assigned this same window UUID, excluding this one. */
  otherOpeningsAssignedSameWindow: number | null;
  /** install_events naming this window but a different opening. */
  eventsNamingWindowOnDifferentOpening: number | null;
}

/**
 * Astra's exact legacy ambiguity rule, pure: a failed lookup is unavailable,
 * never a clean "safe" result; a foreign/duplicate assignment is ambiguous,
 * never silently included.
 */
export function evaluateLegacyAmbiguity(
  input: LegacyAmbiguityInput,
): { allowed: boolean; reason: QcEvidenceProblem["reason"] | null } {
  if (!input.currentAssignedWindowId) return { allowed: false, reason: null };
  if (
    !input.windowProjectIdKnown ||
    input.otherOpeningsAssignedSameWindow == null ||
    input.eventsNamingWindowOnDifferentOpening == null
  ) {
    return { allowed: false, reason: "unavailable" };
  }
  if (input.windowProjectId !== input.expectedProjectId) return { allowed: false, reason: "ambiguous" };
  if (input.otherOpeningsAssignedSameWindow > 0) return { allowed: false, reason: "ambiguous" };
  if (input.eventsNamingWindowOnDifferentOpening > 0) return { allowed: false, reason: "ambiguous" };
  return { allowed: true, reason: null };
}

// ------------------------------------------------------------------ signing

const ATTACHMENT_BUCKET_PREFIX = "install-media/";

/** Attachments storage_path is bucket-prefixed ("install-media/…"). Rejects
 * anything not in that exact shape — no arbitrary first-segment-as-bucket. */
export function parseAttachmentStoragePath(storagePath: string): string | null {
  if (!storagePath.startsWith(ATTACHMENT_BUCKET_PREFIX)) return null;
  const rest = storagePath.slice(ATTACHMENT_BUCKET_PREFIX.length);
  if (!rest || rest.includes("..")) return null;
  return rest;
}

async function signAttachmentPath(storagePath: string): Promise<string | null> {
  const path = parseAttachmentStoragePath(storagePath);
  if (!path) return null;
  const { data, error } = await supabase.storage.from("install-media").createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

/** A phase photo path is raw inside install-media (projectId/…), never
 * bucket-prefixed. Scoped to the expected job as its first path segment. */
export function parsePhasePhotoPath(path: string, expectedProjectId: string): boolean {
  if (!path || path.includes("..")) return false;
  const slash = path.indexOf("/");
  if (slash <= 0) return false;
  return path.slice(0, slash) === expectedProjectId;
}

async function signPhasePhotoPath(path: string, expectedProjectId: string): Promise<string | null> {
  if (!parsePhasePhotoPath(path, expectedProjectId)) return null;
  const { data, error } = await supabase.storage.from("install-media").createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
}

// --------------------------------------------------------------------- read

interface EventsPage {
  rows: QcEvidenceEvent[];
  truncated: boolean;
  failed: boolean;
}

async function readEvents(openingId: string): Promise<EventsPage> {
  const memoCols = MEMO_TOPICS.map((t) => t.key).join(", ");
  const base = `id, project_opening_id, window_id, created_at, started_at, installer, minutes, quality_grade, transcript_raw, photo_findings, voided_at, void_reason, ${memoCols}, voider:voided_by(display_name)`;
  const run = (cols: string) =>
    supabase
      .from("install_events")
      .select(cols, { count: "exact" })
      .eq("project_opening_id", openingId)
      .order("created_at", { ascending: true })
      .range(0, ROW_CAP - 1);

  let result = await run(`${base}, installer_id, credited_to`);
  if (result.error && isMissingColumn(result.error, "credited_to")) {
    result = await run(base);
  }
  if (result.error) return { rows: [], truncated: false, failed: true };
  const rows = (result.data ?? []) as unknown as QcEvidenceEvent[];
  return {
    rows,
    truncated: result.count != null && result.count > rows.length,
    failed: false,
  };
}

const ATTACHMENT_SELECT =
  "id, project_id, project_opening_id, install_event_id, window_id, package_id, service_case_id, kind, storage_path, created_at, taken_at, caption, transcript, deleted_at";

interface AttachmentsPage {
  rows: AttachmentCandidate[];
  truncated: boolean;
  failed: boolean;
}

/** Direct-opening and event-linked branches are required for completeness.
 * Preserve successful branches on a partial failure, while marking the source
 * unavailable so those records cannot be presented as a complete read. */
async function readRequiredAttachments(
  openingId: string,
  canonicalEventIds: readonly string[],
): Promise<AttachmentsPage> {
  const base = () =>
    supabase
      .from("attachments")
      .select(ATTACHMENT_SELECT, { count: "exact" })
      .in("kind", ["photo", "voice_memo"])
      .is("deleted_at", null)
      .is("package_id", null)
      .is("service_case_id", null)
      .range(0, ROW_CAP - 1);

  const reads = [base().eq("project_opening_id", openingId)];
  for (let i = 0; i < canonicalEventIds.length; i += EVENT_ID_BATCH) {
    reads.push(base().in("install_event_id", canonicalEventIds.slice(i, i + EVENT_ID_BATCH)));
  }

  const results = await Promise.all(reads);
  const rows: AttachmentCandidate[] = [];
  let truncated = false;
  let failed = false;
  for (const r of results) {
    if (r.error) { failed = true; continue; }
    const branchRows = (r.data ?? []) as unknown as AttachmentCandidate[];
    rows.push(...branchRows);
    if (r.count != null && r.count > branchRows.length) truncated = true;
  }
  return { rows, truncated, failed };
}

/** The optional legacy branch: window-only, no event/opening target. Only
 * ever called once the ambiguity check has said it is safe to. */
async function readLegacyAttachments(windowId: string): Promise<AttachmentsPage> {
  const { data, error, count } = await supabase
    .from("attachments")
    .select(ATTACHMENT_SELECT, { count: "exact" })
    .in("kind", ["photo", "voice_memo"])
    .is("deleted_at", null)
    .is("package_id", null)
    .is("service_case_id", null)
    .eq("window_id", windowId)
    .is("project_opening_id", null)
    .is("install_event_id", null)
    .range(0, ROW_CAP - 1);
  if (error) return { rows: [], truncated: false, failed: true };
  const rows = (data ?? []) as unknown as AttachmentCandidate[];
  return { rows, truncated: count != null && count > rows.length, failed: false };
}

async function readLegacyAmbiguity(
  openingId: string,
  expectedProjectId: string,
  currentAssignedWindowId: string | null,
  windowProjectId: string | null,
  windowProjectIdKnown: boolean,
): Promise<{ allowed: boolean; reason: QcEvidenceProblem["reason"] | null }> {
  if (!currentAssignedWindowId) return { allowed: false, reason: null };
  if (!windowProjectIdKnown) return { allowed: false, reason: "unavailable" };

  const [otherOpenings, otherEvents] = await Promise.all([
    supabase
      .from("project_openings")
      .select("id", { count: "exact", head: true })
      .eq("assigned_window_id", currentAssignedWindowId)
      .neq("id", openingId),
    supabase
      .from("install_events")
      .select("id", { count: "exact", head: true })
      .eq("window_id", currentAssignedWindowId)
      .neq("project_opening_id", openingId),
  ]);
  const failed = Boolean(otherOpenings.error) || Boolean(otherEvents.error);
  return evaluateLegacyAmbiguity({
    currentAssignedWindowId,
    expectedProjectId,
    windowProjectId,
    windowProjectIdKnown: true,
    otherOpeningsAssignedSameWindow: failed ? null : otherOpenings.count,
    eventsNamingWindowOnDifferentOpening: failed ? null : otherEvents.count,
  });
}

interface PhaseResult {
  loaded: boolean;
  media: QcEvidenceMedia | null;
}

/** Submitted flashing photo, opening-UUID scoped — never the project-wide
 * `listOpeningPhases`, whose missing-table-to-empty fallback would read as a
 * clean "no flashing" for what is actually an unreadable source here. */
async function readFlashingMedia(
  openingId: string,
  expectedProjectId: string,
): Promise<PhaseResult> {
  const { data, error } = await supabase
    .from("opening_phases")
    .select("photo_path, submitted_at")
    .eq("opening_id", openingId)
    .eq("kind", "flashing")
    .eq("status", "submitted")
    .order("submitted_at", { ascending: false })
    .limit(1);
  if (error) {
    return { loaded: false, media: null };
  }
  const row = (data ?? [])[0] as { photo_path: string | null; submitted_at: string | null } | undefined;
  if (!row) return { loaded: true, media: null };
  if (!row.photo_path) return { loaded: false, media: null };
  const signedUrl = await signPhasePhotoPath(row.photo_path, expectedProjectId);
  return {
    loaded: true,
    media: {
      id: `flashing:${openingId}`,
      kind: "photo",
      source: "flashing",
      installEventId: null,
      storagePath: row.photo_path,
      signedUrl,
      createdAt: row.submitted_at,
      caption: null,
      transcript: null,
    },
  };
}

/**
 * The reader. Verifies expectedProjectId BEFORE any media read or signing;
 * throws on a missing/mismatched opening rather than signing under the
 * caller's assumed unit.
 */
export async function loadQcUnitEvidence(
  openingId: string,
  expectedProjectId: string,
): Promise<QcUnitEvidence> {
  const opening = await getOpening(openingId);
  if (!opening) throw new Error("qc_evidence_opening_missing");
  if (opening.project_id !== expectedProjectId) throw new Error("qc_evidence_opening_mismatch");

  const currentAssignedWindowId = opening.assigned_window_id;
  const windowProjectIdKnown = currentAssignedWindowId == null || opening.windows?.id === currentAssignedWindowId;
  const windowProjectId = opening.windows?.project_id ?? null;

  const [eventsPage, legacyAmbiguity, phase] = await Promise.all([
    readEvents(openingId),
    readLegacyAmbiguity(
      openingId,
      expectedProjectId,
      currentAssignedWindowId,
      windowProjectId,
      windowProjectIdKnown,
    ),
    readFlashingMedia(openingId, expectedProjectId),
  ]);

  const problems: QcEvidenceProblem[] = [];
  if (eventsPage.failed) problems.push({ source: "events", reason: "unavailable" });
  else if (eventsPage.truncated) problems.push({ source: "events", reason: "incomplete" });
  if (!phase.loaded) problems.push({ source: "phase", reason: "unavailable" });

  const events = eventsPage.rows;
  const canonicalEventIds = events.map((e) => e.id);
  const eventWindowById = new Map(events.map((e) => [e.id, e.window_id]));
  const knownWindowIds = new Set<string>();
  if (currentAssignedWindowId) knownWindowIds.add(currentAssignedWindowId);
  for (const e of events) if (e.window_id) knownWindowIds.add(e.window_id);

  const requiredAttachments = await readRequiredAttachments(openingId, canonicalEventIds);
  const attachmentsLoaded = !requiredAttachments.failed;
  if (requiredAttachments.failed) problems.push({ source: "attachments", reason: "unavailable" });
  else if (requiredAttachments.truncated) problems.push({ source: "attachments", reason: "incomplete" });

  let legacyLoaded = true;
  let legacyAllowed = legacyAmbiguity.allowed;
  let legacyRows: AttachmentCandidate[] = [];
  if (legacyAmbiguity.reason === "unavailable") {
    legacyLoaded = false;
    problems.push({ source: "legacy", reason: "unavailable" });
  } else if (legacyAmbiguity.reason === "ambiguous") {
    problems.push({ source: "legacy", reason: "ambiguous" });
  } else if (legacyAllowed && currentAssignedWindowId) {
    const legacyPage = await readLegacyAttachments(currentAssignedWindowId);
    if (legacyPage.failed) {
      legacyLoaded = false;
      legacyAllowed = false;
      problems.push({ source: "legacy", reason: "unavailable" });
    } else {
      legacyRows = legacyPage.rows;
      if (legacyPage.truncated) problems.push({ source: "legacy", reason: "incomplete" });
    }
  }

  const candidateRows = [...requiredAttachments.rows, ...legacyRows];
  const { rows: dedupedRows, conflictIds } = dedupeAttachmentCandidates(candidateRows);
  if (conflictIds.length > 0) {
    // Conflicting duplicates are dropped before classification/signing, not
    // merged — a hard failure of the whole read would be the wrong answer
    // when the rest of the candidates are unambiguous.
    problems.push({ source: "attachments", reason: "conflict" });
  }

  const ctx: ClassifyContext = {
    openingId,
    expectedProjectId,
    eventWindowById,
    knownWindowIds,
    currentAssignedWindowId,
    legacyAllowed,
  };

  const media: QcEvidenceMedia[] = [];
  for (const row of dedupedRows) {
    const classified = classifyAttachment(row, ctx);
    if (!classified) {
      // Hidden files are not proof of an empty record. Report only supported,
      // live unit candidates; deleted/package/service media is outside QC.
      if ((row.kind === "photo" || row.kind === "voice_memo") && !row.deleted_at
        && row.package_id == null && row.service_case_id == null) {
        const reason = row.project_opening_id == null && row.install_event_id == null
          && currentAssignedWindowId != null && row.window_id === currentAssignedWindowId && row.project_id == null
          ? "ambiguous" : "conflict";
        if (!problems.some(p => p.source === "attachments" && p.reason === reason)) {
          problems.push({ source: "attachments", reason });
        }
      }
      continue;
    }
    const signedUrl = await signAttachmentPath(row.storage_path);
    media.push({
      id: row.id,
      kind: row.kind as "photo" | "voice_memo",
      source: classified.source,
      installEventId: classified.eventId,
      storagePath: row.storage_path,
      signedUrl,
      createdAt: row.taken_at ?? row.created_at,
      caption: row.caption,
      transcript: row.transcript,
    });
  }
  if (phase.media) media.push(phase.media);

  return {
    opening,
    events,
    media,
    problems,
    sources: {
      eventsLoaded: !eventsPage.failed,
      attachmentsLoaded,
      phaseLoaded: phase.loaded,
      legacyLoaded,
    },
  };
}

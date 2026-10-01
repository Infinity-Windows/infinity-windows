// Where a replayed offline daily log's structured-field disagreements wait
// for a human. mergeQueuedDailyLog (dailyLogMerge.ts) never auto-resolves a
// conflicting stage/unit/delay/safety reading — it leaves the row's current
// value untouched and hands the phone's own conflicting value back here.
// Account-scoped, same storage and shape convention as
// manualDailyLogDraft.ts; this is NOT sent anywhere — it exists only so the
// editor can show "needs your review" and let a person deliberately restore
// their phone's numbers, against the CURRENT revision, rather than either
// side being picked for them.

import type { ProgressConflict } from "./dailyLogMerge";
import type { DailyLogProgressFields } from "./dailyLogStages";

export interface DailyLogProgressConflictRecord {
  version: 1;
  ownerId: string;
  projectId: string;
  logDate: string;
  /** The server revision this conflict was detected against — a later
   * review must re-check this is still current before offering a restore. */
  serverRevision: number;
  conflicts: ProgressConflict[];
  /** The COMPLETE local answer at the moment of conflict, not just the
   * conflicting fields — a restore reinstates this whole snapshot, never a
   * per-field patchwork assembled against whatever the server now holds.
   * Counts and stage readings describe ONE observation; combining a stale
   * field with a newer one can report a fact nobody actually saw. */
  queuedSnapshot: DailyLogProgressFields;
  detectedAt: string;
  sourceEntryId?: string;
}

const PREFIX = "forge.dailyLogProgressConflict.v1";
const key = (ownerId: string, projectId: string, logDate: string) =>
  `${PREFIX}:${ownerId}:${projectId}:${logDate}`;

function validRecord(value: unknown): value is DailyLogProgressConflictRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return r.version === 1 && typeof r.ownerId === "string" && typeof r.projectId === "string"
    && typeof r.logDate === "string" && Number.isSafeInteger(r.serverRevision)
    && Array.isArray(r.conflicts) && !!r.queuedSnapshot && typeof r.queuedSnapshot === "object";
}

export function saveProgressConflicts(record: DailyLogProgressConflictRecord): void {
  if (record.conflicts.length === 0) {
    clearProgressConflicts(record.ownerId, record.projectId, record.logDate);
    return;
  }
  localStorage.setItem(key(record.ownerId, record.projectId, record.logDate), JSON.stringify(record));
}

export function loadProgressConflicts(
  ownerId: string,
  projectId: string,
  logDate: string,
): DailyLogProgressConflictRecord | null {
  try {
    const raw = localStorage.getItem(key(ownerId, projectId, logDate));
    if (!raw) return null;
    const row = JSON.parse(raw) as DailyLogProgressConflictRecord;
    return validRecord(row) && row.ownerId === ownerId && row.projectId === projectId && row.logDate === logDate
      ? row
      : null;
  } catch {
    return null;
  }
}

export function clearProgressConflicts(ownerId: string, projectId: string, logDate: string): void {
  localStorage.removeItem(key(ownerId, projectId, logDate));
}

import type { DailyLogReflection, DayFlow } from "./dailyLogs";
import type { DailyLogProgressFields } from "./dailyLogStages";

export interface ManualDailyLogFields extends DailyLogProgressFields {
  headline: string;
  notes: string;
  dayFlow: DayFlow | null;
  reflection: DailyLogReflection;
  weather: string;
}

export interface ManualDailyLogDraft {
  version: 1;
  ownerId: string;
  projectId: string;
  logDate: string;
  /** null means the server could not be read; zero means confirmed absent. */
  baseRevision: number | null;
  fields: ManualDailyLogFields;
  savedAt: string;
}

const PREFIX = "forge.manualDailyLogDraft.v1";
const key = (ownerId: string, projectId: string, logDate: string) =>
  `${PREFIX}:${ownerId}:${projectId}:${logDate}`;

function validFields(value: unknown): value is ManualDailyLogFields {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return typeof f.headline === "string" && typeof f.notes === "string"
    && typeof f.weather === "string"
    && (f.dayFlow === null || f.dayFlow === "smooth" || f.dayFlow === "fine" || f.dayFlow === "stuck")
    && !!f.reflection && typeof f.reflection === "object";
}

/** Unsent work remains on this device across sign-out, but only its owner can read it. */
export function loadManualDailyLogDraft(ownerId: string, projectId: string, logDate: string): ManualDailyLogDraft | null {
  try {
    const raw = localStorage.getItem(key(ownerId, projectId, logDate));
    if (!raw) return null;
    const row = JSON.parse(raw) as ManualDailyLogDraft;
    return row.version === 1 && row.ownerId === ownerId && row.projectId === projectId
      && row.logDate === logDate && (row.baseRevision === null || Number.isSafeInteger(row.baseRevision) && row.baseRevision >= 0)
      && validFields(row.fields) ? row : null;
  } catch {
    return null;
  }
}

/** Synchronous commit on each edit, so closing or reloading loses no last keystroke. */
export function saveManualDailyLogDraft(draft: ManualDailyLogDraft): void {
  localStorage.setItem(key(draft.ownerId, draft.projectId, draft.logDate), JSON.stringify(draft));
}

export function clearManualDailyLogDraft(ownerId: string, projectId: string, logDate: string): void {
  localStorage.removeItem(key(ownerId, projectId, logDate));
}

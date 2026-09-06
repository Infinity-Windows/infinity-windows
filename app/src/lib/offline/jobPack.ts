// "Save for offline": put one job on the phone, on purpose, before the truck
// leaves.
//
// The persisted query cache (queryClient.ts, OFFLINE_KEYS) keeps whatever a
// screen has already read, and #535 stopped the launch from throwing it away.
// That protects the job somebody opened with signal. It does nothing for the
// job they have not opened yet, and the first unit of the day is the one that
// gets read standing at the opening with no bars. This is the other half: a
// foreman taps once, and the job's openings, specs, demand, brains, the map's
// outlines and elevations, every planset PDF and every mark's picture are on
// the phone, with a record of when, so the button can say so tomorrow.
//
// Pure apart from what the caller hands it: every read and every download
// arrives through `deps`, so the order, the counting and the "keep going when
// a picture fails" rule are tested against fakes and never against Supabase.
// A manual tap is a decision, so nothing here consults the connection type —
// the background warmer (install/prefetchDrawings) is the one that stays
// polite about data.

export interface PackSpec {
  mark_code: string;
  image_page: number | null;
  image_bbox: unknown;
  planset_id?: string | null;
}

export interface PackPlanset {
  id: string;
}

export interface JobPackDeps<P extends PackPlanset = PackPlanset> {
  projects(): Promise<unknown>;
  openings(projectId: string): Promise<{ window_type_id: string | null }[]>;
  markSpecs(projectId: string): Promise<PackSpec[]>;
  plansets(projectId: string): Promise<P[]>;
  projectWindows(projectId: string): Promise<unknown>;
  elevationViews(projectId: string): Promise<unknown>;
  planOutlines(projectId: string): Promise<unknown>;
  typeBrain(typeId: string): Promise<unknown>;
  /** Download (and keep) one planset's bytes. */
  planset(planset: P): Promise<unknown>;
  /**
   * Produce (and keep) one mark's picture. "none" is a real answer: the spec
   * has no box, or no sheet to cut it from — nothing to save, not a failure.
   */
  drawing(plansets: P[], spec: PackSpec): Promise<"saved" | "none">;
}

export interface JobPackProgress {
  done: number;
  total: number;
  /** What just finished, for a progress line: "openings", "planset", "drawing". */
  step: string;
}

export interface JobPackResult {
  projectId: string;
  /** Epoch ms the save finished. */
  at: number;
  specs: number;
  types: number;
  plansets: number;
  drawings: number;
  /** Steps that failed, by label. Empty means everything is on the phone. */
  failed: string[];
}

const BASE_STEPS = [
  "projects",
  "openings",
  "markSpecs",
  "plansets",
  "projectWindows",
  "elevationViews",
  "planOutlines",
] as const;

/**
 * Save one job for offline. Never throws: a failure is one entry in
 * `failed`, and the rest of the job still lands. The base reads run together
 * (they are small); documents and pictures run one at a time, because each
 * one renders a page and a phone has one CPU worth spending.
 */
export async function saveJobOffline<P extends PackPlanset>(
  projectId: string,
  deps: JobPackDeps<P>,
  onProgress?: (p: JobPackProgress) => void,
  now: () => number = Date.now,
): Promise<JobPackResult> {
  const failed: string[] = [];
  let done = 0;
  let total = BASE_STEPS.length;
  const tick = (step: string) => {
    done += 1;
    onProgress?.({ done, total, step });
  };
  // Success is "did not throw", never "returned something": most of these
  // reads return nothing useful, and a fake in a test returns undefined.
  const attempt = async <T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> => {
    try {
      return { ok: true, value: await fn() };
    } catch {
      failed.push(label);
      return { ok: false };
    } finally {
      tick(label);
    }
  };

  const [, openings, specs, plansets] = await Promise.all([
    attempt("projects", () => deps.projects()),
    attempt("openings", () => deps.openings(projectId)),
    attempt("markSpecs", () => deps.markSpecs(projectId)),
    attempt("plansets", () => deps.plansets(projectId)),
    attempt("projectWindows", () => deps.projectWindows(projectId)),
    attempt("elevationViews", () => deps.elevationViews(projectId)),
    attempt("planOutlines", () => deps.planOutlines(projectId)),
  ]);

  const typeIds = [
    ...new Set(
      (openings.ok ? openings.value : [])
        .map((o) => o.window_type_id)
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const sheets = plansets.ok ? plansets.value : [];
  const marks = specs.ok ? specs.value : [];
  total += typeIds.length + sheets.length + marks.length;
  onProgress?.({ done, total, step: "counted" });

  let types = 0;
  for (const typeId of typeIds) {
    if ((await attempt(`typeBrain:${typeId}`, () => deps.typeBrain(typeId))).ok) types += 1;
  }

  let kept = 0;
  for (const sheet of sheets) {
    if ((await attempt(`planset:${sheet.id}`, () => deps.planset(sheet))).ok) kept += 1;
  }

  let drawings = 0;
  for (const spec of marks) {
    const outcome = await attempt(`drawing:${spec.mark_code}`, () => deps.drawing(sheets, spec));
    if (outcome.ok && outcome.value === "saved") drawings += 1;
  }

  return {
    projectId,
    at: now(),
    specs: marks.length,
    types,
    plansets: kept,
    drawings,
    failed,
  };
}

// --- What was saved, and when ------------------------------------------

export interface SavedJobRecord {
  at: number;
  specs: number;
  plansets: number;
  drawings: number;
  failed: number;
}

export const SAVED_JOBS_KEY = "wops-offline-saved";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Every job saved on this phone, by project id. Empty on any failure. */
export function readSavedJobs(s: StorageLike | null = storage()): Record<string, SavedJobRecord> {
  if (!s) return {};
  try {
    const raw = s.getItem(SAVED_JOBS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, SavedJobRecord> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === "object" && typeof (v as SavedJobRecord).at === "number") {
        out[id] = v as SavedJobRecord;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function readSavedJob(projectId: string, s: StorageLike | null = storage()): SavedJobRecord | null {
  return readSavedJobs(s)[projectId] ?? null;
}

/** Remember a finished save. Silent on failure — the save still happened. */
export function recordSavedJob(result: JobPackResult, s: StorageLike | null = storage()): void {
  if (!s) return;
  try {
    const all = readSavedJobs(s);
    all[result.projectId] = {
      at: result.at,
      specs: result.specs,
      plansets: result.plansets,
      drawings: result.drawings,
      failed: result.failed.length,
    };
    s.setItem(SAVED_JOBS_KEY, JSON.stringify(all));
  } catch {
    // Quota or private mode. The next visit just does not know the date.
  }
}

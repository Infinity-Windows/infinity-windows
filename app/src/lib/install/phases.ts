// Opening phases: work on an opening that isn't the install.
//
// Flashing is the first (and so far only) phase: its own clock, its own
// finished-work photo, done by whoever gets there first — the assigned
// installer owns the INSTALL finishing, never the whole window. The server
// (20260811000000_opening_phases.sql) enforces everything that matters:
// clocked-in + toolbox to start, photo required to submit, minutes computed
// and believability-capped server-side, and the install refused while a
// required flashing is unsubmitted.
//
// Until the migration is applied, every reader here degrades to "no phases"
// (same missing-table manners as the timecard's new tables) so the app never
// shows an error screen for a feature the database hasn't met yet.

import { supabase } from "../supabase";

export type PhaseKind = "flashing";

export interface OpeningPhase {
  id: string;
  opening_id: string;
  kind: PhaseKind;
  status: "active" | "submitted";
  started_at: string;
  started_by: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  minutes: number | null;
  photo_path: string | null;
  /** Running pause stamp; null while the clock is ticking. */
  paused_at?: string | null;
  /** Accumulated paused time from finished pauses, seconds. */
  paused_seconds?: number | null;
  starter?: { display_name: string } | null;
  submitter?: { display_name: string } | null;
}

function isMissingTableError(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return /could not find the table|relation .+ does not exist/i.test(e.message ?? "");
}

const PHASE_SELECT =
  "id, opening_id, kind, status, started_at, started_by, submitted_at, submitted_by, minutes, photo_path, starter:started_by(display_name), submitter:submitted_by(display_name)";

/** Every phase row for a project's openings, one query for a whole screen. */
export async function listOpeningPhases(projectId: string): Promise<OpeningPhase[]> {
  const { data, error } = await supabase
    .from("opening_phases")
    .select(`${PHASE_SELECT}, opening:project_openings!inner(project_id)`)
    .eq("opening.project_id", projectId);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as OpeningPhase[];
}

export async function startOpeningPhase(
  openingId: string,
  kind: PhaseKind,
): Promise<OpeningPhase> {
  const { data, error } = await supabase.rpc("start_opening_phase", {
    p_opening_id: openingId,
    p_kind: kind,
  });
  if (error) throw error;
  return data as OpeningPhase;
}

/**
 * Upload the finished-work photo, then submit the phase with its path.
 * The photo is the record and the server refuses a submit without it, so
 * this needs signal — a flashing run is an outdoor, walk-the-building job,
 * and v1 accepts that trade instead of half-submitting offline.
 */
export async function submitOpeningPhase(opts: {
  openingId: string;
  kind: PhaseKind;
  projectId: string;
  openingCode: string;
  photo: Blob;
  contentType?: string;
}): Promise<OpeningPhase> {
  const stamp = Date.now();
  const path = `${opts.projectId}/${opts.openingCode}/${stamp}-${opts.kind}.jpg`;
  const { error: upErr } = await supabase.storage
    .from("install-media")
    .upload(path, opts.photo, {
      contentType: opts.contentType || "image/jpeg",
      upsert: true,
    });
  if (upErr) throw upErr;

  const { data, error } = await supabase.rpc("submit_opening_phase", {
    p_opening_id: opts.openingId,
    p_kind: opts.kind,
    p_photo_path: path,
  });
  if (error) throw error;
  return data as OpeningPhase;
}

/**
 * The foreman's flashing alarm (owner, 2026-08-17): windows are waiting on
 * flashing and NOBODY is on a flash run. `owed` counts openings still owed
 * flashing; `runActive` is true when any flashing phase is running right
 * now. The alarm fires when owed > 0 and no run is active — windows sitting
 * for want of a dispatch is a management failure, so it goes on the
 * foreman's landing page, big.
 */
export function flashingAlarm(
  openings: readonly { id: string; needs_flashing?: boolean | null }[],
  phases: readonly OpeningPhase[],
): { owed: number; runActive: boolean; alarm: boolean } {
  const owed = openings.filter((o) =>
    flashingOutstanding(o, phases.filter((p) => p.opening_id === o.id)),
  ).length;
  const runActive = phases.some(
    (p) => p.kind === "flashing" && p.status === "active",
  );
  return { owed, runActive, alarm: owed > 0 && !runActive };
}

/** The one question the install gate asks. */
export function flashingOutstanding(
  opening: { needs_flashing?: boolean | null },
  phases: OpeningPhase[],
): boolean {
  if (opening.needs_flashing !== true) return false;
  return !phases.some((p) => p.kind === "flashing" && p.status === "submitted");
}

export async function setOpeningNeedsFlashing(
  openingId: string,
  needs: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_opening_needs_flashing", {
    p_opening_id: openingId,
    p_needs: needs,
  });
  if (error) throw error;
}

/** Foreman's one-tap job default: returns how many openings changed. */
export async function setProjectNeedsFlashing(
  projectId: string,
  needs: boolean,
): Promise<number> {
  const { data, error } = await supabase.rpc("set_project_needs_flashing", {
    p_project_id: projectId,
    p_needs: needs,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Live worked seconds for an active phase: span net of every pause. */
export function phaseElapsedSeconds(
  phase: Pick<OpeningPhase, "started_at" | "paused_at" | "paused_seconds">,
  nowMs: number,
): number {
  const started = new Date(phase.started_at).getTime();
  const pausedDone = (phase.paused_seconds ?? 0) * 1000;
  const openPause = phase.paused_at
    ? Math.max(0, nowMs - new Date(phase.paused_at).getTime())
    : 0;
  return Math.max(0, Math.floor((nowMs - started - pausedDone - openPause) / 1000));
}

export function formatPhaseClock(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export async function pauseOpeningPhase(openingId: string, kind: PhaseKind): Promise<OpeningPhase> {
  const { data, error } = await supabase.rpc("pause_opening_phase", {
    p_opening_id: openingId,
    p_kind: kind,
  });
  if (error) throw error;
  return data as OpeningPhase;
}

export async function resumeOpeningPhase(openingId: string, kind: PhaseKind): Promise<OpeningPhase> {
  const { data, error } = await supabase.rpc("resume_opening_phase", {
    p_opening_id: openingId,
    p_kind: kind,
  });
  if (error) throw error;
  return data as OpeningPhase;
}

/** Started on the wrong window: erase the active clock, file nothing. */
export async function cancelOpeningPhase(openingId: string, kind: PhaseKind): Promise<void> {
  const { error } = await supabase.rpc("cancel_opening_phase", {
    p_opening_id: openingId,
    p_kind: kind,
  });
  if (error) throw error;
}

export interface MyActivePhase extends OpeningPhase {
  opening?: {
    opening_code: string;
    project_id: string;
    projects?: { job_code: string } | null;
  } | null;
}

/**
 * The phase clocks THIS person has running, for the clock sheet's
 * "what you're on right now" card. started_by is the scope: a phase is a
 * personal clock even though the flashed window itself is crew-wide truth.
 */
export async function listMyActivePhases(profileId: string): Promise<MyActivePhase[]> {
  const { data, error } = await supabase
    .from("opening_phases")
    .select(
      `${PHASE_SELECT}, opening:project_openings!inner(opening_code, project_id, projects(job_code))`,
    )
    .eq("started_by", profileId)
    .eq("status", "active");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as MyActivePhase[];
}

/**
 * The run's CURRENT target when several runners leapfrog one queue
 * (owner, 2026-08-14: assignable to 1,2,3… installers "who can select the
 * window they are flashing"). An explicit pick wins; otherwise resume the
 * window I already have a clock on; otherwise the first window nobody
 * else is actively flashing; otherwise the head of the queue.
 */
export function flashRunTarget<T extends { id: string }>(
  queue: T[],
  phases: OpeningPhase[],
  pickedId: string | null,
  myProfileId: string | null,
): T | null {
  if (pickedId) {
    const hit = queue.find((o) => o.id === pickedId);
    if (hit) return hit;
  }
  const active = phases.filter((p) => p.kind === "flashing" && p.status === "active");
  if (myProfileId) {
    const mine = active.find((p) => p.started_by === myProfileId);
    if (mine) {
      const hit = queue.find((o) => o.id === mine.opening_id);
      if (hit) return hit;
    }
  }
  const busy = new Set(active.map((p) => p.opening_id));
  return queue.find((o) => !busy.has(o.id)) ?? queue[0] ?? null;
}

// ------------------------------------------------- flash run assignments
// The flash run is its own dispatched task (owner, 2026-08-14): foremen
// put 1..N runners on a job from the Dispatch tab; runners see the run in
// My Work. Flashing time itself still lives on opening_phases per window.

export interface FlashRunAssignment {
  id: string;
  project_id: string;
  profile_id: string;
  assigned_by: string | null;
  assigned_at: string;
  profile?: { display_name: string | null } | null;
  projects?: { job_code: string; name: string | null } | null;
}

/** A job's flash runners, for the Dispatch card. */
export async function listFlashRunners(projectId: string): Promise<FlashRunAssignment[]> {
  const { data, error } = await supabase
    .from("flash_run_assignments")
    .select("*, profile:profiles!flash_run_assignments_profile_id_fkey(display_name)")
    .eq("project_id", projectId)
    .order("assigned_at");
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as FlashRunAssignment[];
}

/** THIS person's flash runs across every job, for the My Work card. */
export async function listMyFlashRuns(profileId: string): Promise<FlashRunAssignment[]> {
  const { data, error } = await supabase
    .from("flash_run_assignments")
    .select("*, projects(job_code, name)")
    .eq("profile_id", profileId);
  if (isMissingTableError(error)) return [];
  if (error) throw error;
  return (data ?? []) as unknown as FlashRunAssignment[];
}

export async function assignFlashRunner(projectId: string, profileId: string): Promise<void> {
  const { error } = await supabase.rpc("assign_flash_runner", {
    p_project_id: projectId,
    p_profile_id: profileId,
  });
  if (error) throw error;
}

export async function unassignFlashRunner(projectId: string, profileId: string): Promise<void> {
  const { error } = await supabase.rpc("unassign_flash_runner", {
    p_project_id: projectId,
    p_profile_id: profileId,
  });
  if (error) throw error;
}

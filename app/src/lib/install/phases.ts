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

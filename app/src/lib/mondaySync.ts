// Client side of the Monday.com connector: read the staged incoming jobs,
// trigger the (self-throttled) sync, and turn a staged row into a real app
// project with the office's job code. The sync itself lives in the
// monday-sync edge function; see its header for the full design.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import { createProject, type CreateProjectInput } from "./api";

export interface MondayJob {
  id: string;
  monday_item_id: string;
  name: string;
  group_title: string | null;
  status: string | null;
  job_type: string | null;
  start_date: string | null;
  end_date: string | null;
  est_arrival: string | null;
  budget: number | null;
  flashing_note: string | null;
  synced_at: string;
  project_id: string | null;
  dismissed_at: string | null;
}

/** Staged Monday jobs awaiting review — newest sync first. */
export async function listIncomingMondayJobs(): Promise<MondayJob[]> {
  const { data, error } = await supabase
    .from("monday_jobs")
    .select("*")
    .is("project_id", null)
    .is("dismissed_at", null)
    .is("left_groups_at", null)
    .order("start_date", { ascending: true, nullsFirst: false });
  if (error) {
    if (isMissingTable(error, "monday_jobs")) return [];
    throw error;
  }
  return (data ?? []) as MondayJob[];
}

/**
 * Ask the edge function to refresh from Monday. Fire-and-forget from the
 * Jobs page: the function itself throttles to one real sync per ~10 min,
 * so calling on every page load is safe and keeps working-hours freshness
 * around 15 minutes without any cron. `force` bypasses the throttle
 * (the manual "Sync now" button).
 */
export async function triggerMondaySync(force = false): Promise<{
  ok: boolean;
  synced?: number;
  skipped?: string;
  error?: string;
}> {
  const { data, error } = await supabase.functions.invoke("monday-sync", {
    body: { force },
  });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; synced?: number; skipped?: string };
}

/** Build a real project from a staged row and link the two. */
export async function buildProjectFromMonday(
  job: MondayJob,
  input: CreateProjectInput,
): Promise<void> {
  const project = await createProject(input);
  const { error } = await supabase
    .from("monday_jobs")
    .update({ project_id: project.id })
    .eq("id", job.id);
  if (error) throw error;
}

export async function dismissMondayJob(id: string): Promise<void> {
  const { error } = await supabase
    .from("monday_jobs")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

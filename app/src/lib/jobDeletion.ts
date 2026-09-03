// Delete a job — supervisor+, with a reason, and every supervisor is told
// (standard-tracking-jobs slice 5, 2026-09-03).
//
// WHY (owner ask): a bad job — a mistaken quick tracking job, a duplicate
// callback, a test that leaked onto the board — needs to be deletable by a
// supervisor, not only the owner, and deleting one is a big enough act that
// it demands a reason AND puts a notice in front of every supervisor. The
// 30-day recoverable trash (trash_project / restore_project, 20260959000000)
// is unchanged; slice 5 widens the gate to supervisor+ and adds the reason
// and the notice.
//
// deleteJob is the one door the delete buttons call: it writes through
// trash_project (which stores the reason) and then, best-effort, rings every
// supervisor with who/what/why. The push never blocks or fails the delete.

import { supabase } from "./supabase";
import { getRealProfile, listProfiles } from "./install/api";
import { isSupervisorPlus, type CrewRole, type Profile } from "./install/types";
import { sendPush } from "./permissions/pushServer";
import type { Project } from "./types";

/** Every supervisor+ profile id — who a deletion notice goes to. Pure so the
 * audience is tested without a database or a push. `role` is left loose (raw
 * string tolerated) — isSupervisorPlus normalises it. */
export function supervisorIds(
  profiles: readonly { id: string; role?: CrewRole | string | null }[],
): string[] {
  const out: string[] = [];
  for (const p of profiles) if (p.id && isSupervisorPlus(p.role)) out.push(p.id);
  return out;
}

/**
 * Tell every supervisor a job was deleted — who did it, which job, and why.
 * Best-effort: any read failing, or nobody to tell, returns false and the
 * delete still stands. Reads are mockable so the target list and the message
 * are what the test pins.
 */
export async function notifyJobDeleted(
  project: Pick<Project, "id" | "job_code" | "name">,
  reason: string,
): Promise<boolean> {
  let profiles: Pick<Profile, "id" | "role">[] = [];
  let me: Profile | null = null;
  try {
    [profiles, me] = await Promise.all([listProfiles(), getRealProfile()]);
  } catch {
    return false; // a notice is a nicety, never a blocker
  }
  const profileIds = supervisorIds(profiles);
  if (profileIds.length === 0) return false;
  const who = me?.display_name ?? "A supervisor";
  const label = `${project.job_code} · ${project.name}`;
  return sendPush({
    profileIds,
    title: `Job deleted — ${project.job_code}`,
    body: `${who} deleted ${label}. Reason: ${reason}. 30 days to undo from Job history.`,
    tag: `job-deleted-${project.id}`,
    url: "/jobs/history",
  });
}

/**
 * Move a job to the 30-day trash (supervisor+, server-enforced), storing the
 * required reason, then notify every supervisor. A blank reason is refused
 * before the write — the server refuses it too, this just fails faster and in
 * plainer words. Returns the trashed project row.
 */
export async function deleteJob(projectId: string, reason: string): Promise<Project> {
  const trimmed = (reason ?? "").trim();
  if (!trimmed) throw new Error("Give a reason for deleting this job.");
  const { data, error } = await supabase.rpc("trash_project", {
    p_project_id: projectId,
    p_reason: trimmed,
  });
  if (error) throw error;
  const project = data as Project;
  void notifyJobDeleted(project, trimmed);
  return project;
}

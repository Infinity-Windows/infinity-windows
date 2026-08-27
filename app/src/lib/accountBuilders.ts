// Wave S, S5: the client face of /account/builders. Every write goes
// through an owner-only SECURITY DEFINER RPC (20260950000000_partner_wall.sql)
// — there is no direct-write path to partner_job_grants or partner_invites
// for any of this to bypass.
import { supabase } from "./supabase";

export interface PartnerLogin {
  id: string;
  display_name: string;
  created_at: string;
}

export interface PartnerInvite {
  email: string;
  invited_by: string | null;
  created_at: string;
}

export interface PartnerJobGrant {
  partner_profile_id: string;
  project_id: string;
}

export interface GrantableJob {
  id: string;
  name: string;
  job_code: string;
  status: string;
}

export async function listPartnerLogins(): Promise<PartnerLogin[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, created_at")
    .eq("is_partner", true)
    .order("display_name");
  if (error) throw error;
  return (data ?? []) as PartnerLogin[];
}

export async function listPartnerInvites(): Promise<PartnerInvite[]> {
  const { data, error } = await supabase
    .from("partner_invites")
    .select("email, invited_by, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PartnerInvite[];
}

export async function listPartnerJobGrants(): Promise<PartnerJobGrant[]> {
  const { data, error } = await supabase
    .from("partner_job_grants")
    .select("partner_profile_id, project_id");
  if (error) throw error;
  return (data ?? []) as PartnerJobGrant[];
}

/** Active + finished jobs — S5's own grantable set. A cancelled job never
 * shows here, so it can never be granted (revoking one already granted
 * still works the same way regardless of the job's later status). */
export async function listGrantableJobs(): Promise<GrantableJob[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, job_code, status")
    .in("status", ["active", "completed"])
    .order("name");
  if (error) throw error;
  return (data ?? []) as GrantableJob[];
}

export async function addPartnerInvite(email: string): Promise<void> {
  const { error } = await supabase.rpc("add_partner_invite", { p_email: email });
  if (error) throw error;
}

export async function removePartnerInvite(email: string): Promise<void> {
  const { error } = await supabase.rpc("remove_partner_invite", { p_email: email });
  if (error) throw error;
}

export async function grantPartnerJob(partnerId: string, projectId: string): Promise<void> {
  const { error } = await supabase.rpc("grant_partner_job", {
    p_partner: partnerId,
    p_project: projectId,
  });
  if (error) throw error;
}

export async function revokePartnerJob(partnerId: string, projectId: string): Promise<void> {
  const { error } = await supabase.rpc("revoke_partner_job", {
    p_partner: partnerId,
    p_project: projectId,
  });
  if (error) throw error;
}

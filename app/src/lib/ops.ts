import { supabase } from "./supabase";

// --- Safety ---
export interface SafetyTalk { id: string; title: string; body: string; talk_date: string; }
export interface Incident {
  id: string; description: string; severity: string; created_at: string;
  profiles?: { display_name: string } | null;
  projects?: { job_code: string } | null;
}

export async function getTodayTalk(): Promise<SafetyTalk | null> {
  const { data, error } = await supabase
    .from("safety_talks").select("*")
    .order("talk_date", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data as SafetyTalk | null;
}
export async function ackTalk(talkId: string, profileId: string): Promise<void> {
  const { error } = await supabase.from("safety_acks")
    .upsert({ talk_id: talkId, profile_id: profileId }, { onConflict: "talk_id,profile_id" });
  if (error) throw error;
}
export async function myAck(talkId: string, profileId: string): Promise<boolean> {
  const { data } = await supabase.from("safety_acks")
    .select("talk_id").eq("talk_id", talkId).eq("profile_id", profileId).maybeSingle();
  return Boolean(data);
}
export async function reportIncident(payload: {
  profileId?: string; projectId?: string | null; description: string; severity: string;
}): Promise<void> {
  const { error } = await supabase.from("incidents").insert({
    profile_id: payload.profileId ?? null, project_id: payload.projectId ?? null,
    description: payload.description, severity: payload.severity,
  });
  if (error) throw error;
}
export async function listIncidents(): Promise<Incident[]> {
  const { data, error } = await supabase.from("incidents")
    .select("*, profiles(display_name), projects(job_code)")
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as Incident[];
}

// --- Tools ---
export interface Tool {
  id: string; name: string; holder_id: string | null; calibration_due: string | null; note: string | null;
  profiles?: { display_name: string } | null;
}
export async function listTools(): Promise<Tool[]> {
  const { data, error } = await supabase.from("tools")
    .select("*, profiles:holder_id(display_name)").order("name");
  if (error) throw error;
  return (data ?? []) as Tool[];
}
export async function addTool(name: string, calibrationDue?: string | null): Promise<void> {
  const { error } = await supabase.from("tools").insert({ name, calibration_due: calibrationDue ?? null });
  if (error) throw error;
}
export async function setToolHolder(id: string, holderId: string | null): Promise<void> {
  const { error } = await supabase.from("tools").update({ holder_id: holderId }).eq("id", id);
  if (error) throw error;
}

// --- Supplies ---
export interface Supply { id: string; name: string; unit: string; }
export interface SupplyOrder {
  id: string; project_id: string | null; name: string | null; qty: number; status: string;
  supplies?: { name: string; unit: string } | null;
}
export async function listSupplies(): Promise<Supply[]> {
  const { data, error } = await supabase.from("supplies").select("*").order("name");
  if (error) throw error;
  return (data ?? []) as Supply[];
}
export async function addSupply(name: string, unit: string): Promise<void> {
  const { error } = await supabase.from("supplies").insert({ name, unit });
  if (error) throw error;
}
export async function listOrders(projectId: string): Promise<SupplyOrder[]> {
  const { data, error } = await supabase.from("supply_orders")
    .select("*, supplies(name, unit)").eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SupplyOrder[];
}
export async function addOrder(projectId: string, supplyId: string, qty: number): Promise<void> {
  const { error } = await supabase.from("supply_orders")
    .insert({ project_id: projectId, supply_id: supplyId, qty });
  if (error) throw error;
}
export async function setOrderStatus(id: string, status: string): Promise<void> {
  const { error } = await supabase.from("supply_orders").update({ status }).eq("id", id);
  if (error) throw error;
}

// --- QC ---
export interface QcRow {
  id: string; opening_code: string; project_id: string; status: string;
  window_types?: { type_code: string } | null;
  qc?: { status: string } | null;
}
export async function listInstalledForQc(): Promise<QcRow[]> {
  const { data, error } = await supabase.from("project_openings")
    .select("id, opening_code, project_id, status, window_types(type_code), qc:qc_checks(status)")
    .eq("status", "installed").order("opening_code").limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as QcRow[];
}
export async function setQc(openingId: string, status: "passed" | "callback", note?: string): Promise<void> {
  const { error } = await supabase.from("qc_checks").upsert(
    { project_opening_id: openingId, status, note: note ?? null, checked_at: new Date().toISOString() },
    { onConflict: "project_opening_id" },
  );
  if (error) throw error;
}

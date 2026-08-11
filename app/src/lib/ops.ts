import { supabase } from "./supabase";

// --- Safety ---
export interface TalkSections {
  intro?: string;
  key_hazards?: string[];
  steps?: string[];
  dos?: string[];
  donts?: string[];
}
export interface TalkVisualAid {
  prompt: string;
  url?: string;
}
export interface SafetyTalk {
  id: string;
  title: string;
  body: string;
  talk_date: string;
  sections_json?: TalkSections | null;
  visual_aids_json?: TalkVisualAid[] | null;
  // Structured library fields (toolbox_talk_library port, 2026-08-11).
  library_slug?: string | null;
  category?: string | null;
  citation?: string | null;
  key_points?: string[] | null;
  watch_for?: string[] | null;
  stop_work_line?: string | null;
  pledge?: string | null;
}

/** A reusable talk from the library (browse/assign surface). */
export interface LibraryTalk {
  id: string;
  slug: string;
  category: string;
  position: number;
  title: string;
  citation: string | null;
  briefing: string;
  key_points: string[];
  watch_for: string[];
  stop_work_line: string | null;
  pledge: string | null;
  is_active: boolean;
}

export const TALK_CATEGORY_LABELS: Record<string, string> = {
  lifting: "Heavy units & lifting",
  glass: "Glass & sash",
  cutting: "Cuts, blades & tools",
  heights: "Ladders, openings & falls",
  site: "Jobsite & health",
};
export interface Incident {
  id: string; description: string; severity: string; created_at: string;
  profiles?: { display_name: string } | null;
  projects?: { job_code: string } | null;
}

/** Local calendar date — the phone's day is the crew's day. */
function localTalkDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Today's talk, properly date-matched. If no row exists for today yet, the
 * rotation RPC creates one (assignment override -> weekday category ->
 * weekly rotation; weekends walk the whole library). Falls back to the old
 * newest-row behavior when the rotation isn't migrated yet, so an
 * unmigrated build degrades to exactly what it did before.
 */
export async function getTodayTalk(): Promise<SafetyTalk | null> {
  const today = localTalkDate();
  const { data, error } = await supabase
    .from("safety_talks").select("*")
    .eq("talk_date", today)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!error && data) return data as SafetyTalk;

  const rpc = await supabase.rpc("get_or_create_toolbox_talk_for_date", {
    p_date: today,
  });
  if (!rpc.error && rpc.data) return rpc.data as SafetyTalk;

  // Missing RPC / empty library / legacy schema: newest talk, as before.
  const legacy = await supabase
    .from("safety_talks").select("*")
    .order("talk_date", { ascending: false }).limit(1).maybeSingle();
  if (legacy.error) throw legacy.error;
  return legacy.data as SafetyTalk | null;
}

export async function listLibraryTalks(): Promise<LibraryTalk[]> {
  const { data, error } = await supabase
    .from("toolbox_talk_library").select("*")
    .eq("is_active", true)
    .order("category").order("position");
  if (error) throw error;
  return (data ?? []) as LibraryTalk[];
}

export interface TalkAssignment {
  id: string;
  library_id: string;
  assigned_date: string;
}

export async function listTalkAssignments(fromDate: string): Promise<TalkAssignment[]> {
  const { data, error } = await supabase
    .from("toolbox_talk_assignments")
    .select("id, library_id, assigned_date")
    .gte("assigned_date", fromDate)
    .order("assigned_date");
  if (error) throw error;
  return (data ?? []) as TalkAssignment[];
}

/**
 * Pin a library talk to a date (leads). Replaces any prior assignment for
 * that date; if the date's daily instance was already generated, it is
 * re-pointed so the override actually shows.
 */
export async function assignTalk(libraryId: string, dateISO: string): Promise<void> {
  await supabase.from("toolbox_talk_assignments").delete().eq("assigned_date", dateISO);
  const { error } = await supabase
    .from("toolbox_talk_assignments")
    .insert({ library_id: libraryId, assigned_date: dateISO });
  if (error) throw error;
  // A pre-generated instance for the date would mask the override — clear
  // it only if nobody has signed it yet (completions must keep their talk).
  const { data: existing } = await supabase
    .from("safety_talks").select("id").eq("talk_date", dateISO);
  for (const t of existing ?? []) {
    const { data: sigs } = await supabase
      .from("toolbox_completions").select("id").eq("talk_id", t.id).limit(1);
    if ((sigs ?? []).length === 0) {
      await supabase.from("safety_talks").delete().eq("id", t.id);
    }
  }
}

export async function removeTalkAssignment(id: string): Promise<void> {
  const { error } = await supabase
    .from("toolbox_talk_assignments").delete().eq("id", id);
  if (error) throw error;
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
  assigned_window_id: string | null;
  window_types?: { type_code: string } | null;
  qc?: { status: string } | null;
}
export async function listInstalledForQc(): Promise<QcRow[]> {
  const { data, error } = await supabase.from("project_openings")
    .select("id, opening_code, project_id, status, assigned_window_id, window_types(type_code), qc:qc_checks(status)")
    .eq("status", "installed").order("opening_code").limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as QcRow[];
}
/** Opening ids on this project whose QC check says 'passed' (green glow). */
export async function listQcPassedOpeningIds(projectId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("qc_checks")
    .select("project_opening_id, opening:project_openings!inner(project_id)")
    .eq("status", "passed")
    .eq("opening.project_id", projectId);
  if (error) throw error;
  return (data ?? []).map(
    (r) => (r as { project_opening_id: string }).project_opening_id,
  );
}

export async function setQc(openingId: string, status: "passed" | "callback", note?: string): Promise<void> {
  const { error } = await supabase.from("qc_checks").upsert(
    { project_opening_id: openingId, status, note: note ?? null, checked_at: new Date().toISOString() },
    { onConflict: "project_opening_id" },
  );
  if (error) throw error;
}

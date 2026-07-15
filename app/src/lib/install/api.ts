import { supabase } from "../supabase";
import type { WindowType } from "../types";
import type { DraftOpening } from "./extract";
import type {
  InstallEvent,
  MemoTopics,
  Planset,
  PlansetFormat,
  PlansetStatus,
  ProjectOpening,
} from "./types";

const OPENING_SELECT =
  "*, window_types(*), windows:assigned_window_id(*), projects(*)";

async function actor(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.email ?? null;
}

// --- Plansets ---

export function plansetFormatFromName(name: string): PlansetFormat | null {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf" || ext === "dwg" || ext === "dxf") return ext;
  return null;
}

export async function listPlansets(projectId: string): Promise<Planset[]> {
  const { data, error } = await supabase
    .from("project_plansets")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function uploadPlanset(
  projectId: string,
  file: File,
): Promise<Planset> {
  const format = plansetFormatFromName(file.name);
  if (!format) throw new Error("Only PDF, DWG, or DXF plansets are supported.");

  const safeName = file.name.replace(/[^\w.-]+/g, "_");
  const path = `${projectId}/${Date.now()}-${safeName}`;
  const { error: upErr } = await supabase.storage
    .from("plansets")
    .upload(path, file, { contentType: file.type || undefined });
  if (upErr) throw upErr;

  // DWG/DXF can't convert client-side; store raw and mark conversion pending.
  const status: PlansetStatus = format === "pdf" ? "uploaded" : "converting";
  const { data, error } = await supabase
    .from("project_plansets")
    .insert({
      project_id: projectId,
      storage_path: path,
      source_format: format,
      status,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updatePlanset(
  id: string,
  patch: Partial<Pick<Planset, "status" | "page_count" | "converted_pdf_path">>,
): Promise<void> {
  const { error } = await supabase
    .from("project_plansets")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
}

export async function downloadPlanset(planset: Planset): Promise<ArrayBuffer> {
  const path = planset.converted_pdf_path ?? planset.storage_path;
  const { data, error } = await supabase.storage.from("plansets").download(path);
  if (error) throw error;
  return data.arrayBuffer();
}

// --- Openings ---

export async function listOpenings(
  projectId: string,
): Promise<ProjectOpening[]> {
  const { data, error } = await supabase
    .from("project_openings")
    .select(OPENING_SELECT)
    .eq("project_id", projectId)
    .order("opening_code");
  if (error) throw error;
  return data;
}

export async function getOpening(id: string): Promise<ProjectOpening | null> {
  const { data, error } = await supabase
    .from("project_openings")
    .select(OPENING_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Save a fresh extract as unconfirmed drafts. Guardrail (same philosophy as
 * the Horizon BOM rule): confirmed openings are never deleted or overwritten
 * by a re-extract — only unconfirmed drafts are replaced, and draft codes
 * that collide with confirmed openings are skipped.
 */
export async function saveDraftOpenings(
  projectId: string,
  plansetId: string,
  drafts: DraftOpening[],
): Promise<{ inserted: number; skipped: number }> {
  if (drafts.length === 0) return { inserted: 0, skipped: 0 };

  const { data: existing, error: exErr } = await supabase
    .from("project_openings")
    .select("id, opening_code, confirmed, status")
    .eq("project_id", projectId);
  if (exErr) throw exErr;

  // Protected = confirmed OR already progressed past planning (assigned /
  // installed). Only untouched drafts are replaced by a re-extract.
  const isProtected = (o: { confirmed: boolean; status: string }) =>
    o.confirmed || o.status !== "planned";
  const confirmedCodes = new Set(
    existing.filter(isProtected).map((o) => o.opening_code),
  );
  const staleDraftIds = existing.filter((o) => !isProtected(o)).map((o) => o.id);

  if (staleDraftIds.length > 0) {
    const { error: delErr } = await supabase
      .from("project_openings")
      .delete()
      .in("id", staleDraftIds);
    if (delErr) throw delErr;
  }

  const fresh = drafts.filter((d) => !confirmedCodes.has(d.opening_code));
  const skipped = drafts.length - fresh.length;
  if (fresh.length === 0) return { inserted: 0, skipped };

  const { error } = await supabase.from("project_openings").insert(
    fresh.map((d) => ({
      project_id: projectId,
      planset_id: plansetId,
      opening_code: d.opening_code,
      window_type_id: d.window_type_id,
      label: d.label,
      page_number: d.page_number,
      confirmed: false,
    })),
  );
  if (error) throw error;
  return { inserted: fresh.length, skipped };
}

export async function updateOpening(
  id: string,
  patch: Partial<
    Pick<
      ProjectOpening,
      "opening_code" | "window_type_id" | "label" | "page_number" | "pin_x" | "pin_y"
    >
  >,
): Promise<void> {
  const { error } = await supabase
    .from("project_openings")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
}

export async function deleteOpening(id: string): Promise<void> {
  const { error } = await supabase
    .from("project_openings")
    .delete()
    .eq("id", id)
    .neq("status", "installed");
  if (error) throw error;
}

export async function confirmOpenings(projectId: string): Promise<void> {
  const { error } = await supabase
    .from("project_openings")
    .update({ confirmed: true })
    .eq("project_id", projectId)
    .eq("confirmed", false);
  if (error) throw error;
}

export async function addOpening(
  projectId: string,
  opening: {
    opening_code: string;
    window_type_id?: string | null;
    label?: string | null;
    page_number?: number;
  },
): Promise<ProjectOpening> {
  const { data, error } = await supabase
    .from("project_openings")
    .insert({ project_id: projectId, confirmed: true, ...opening })
    .select(OPENING_SELECT)
    .single();
  if (error) throw error;
  return data;
}

// --- Assignment + install events (RPCs) ---

export async function assignWindowToOpening(
  openingId: string,
  windowUuid: string,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("assign_window_to_opening", {
    p_opening_id: openingId,
    p_window_id: windowUuid,
    p_actor: await actor(),
  });
  if (error) throw error;
  return data as ProjectOpening;
}

export interface SubmitInstallParams extends Partial<MemoTopics> {
  openingId: string;
  minutes?: number | null;
  qualityGrade?: number | null;
  transcriptRaw?: string | null;
  startedAt?: string | null;
}

export async function submitInstallEvent(
  params: SubmitInstallParams,
): Promise<InstallEvent> {
  const { data, error } = await supabase.rpc("submit_install_event", {
    p_opening_id: params.openingId,
    p_installer: await actor(),
    p_minutes: params.minutes ?? null,
    p_quality_grade: params.qualityGrade ?? null,
    p_difficulty: params.difficulty ?? null,
    p_went_well: params.went_well ?? null,
    p_went_poorly: params.went_poorly ?? null,
    p_obstacles: params.obstacles ?? null,
    p_tools_helped: params.tools_helped ?? null,
    p_time_vs_estimate: params.time_vs_estimate ?? null,
    p_safety_notes: params.safety_notes ?? null,
    p_do_again: params.do_again ?? null,
    p_transcript_raw: params.transcriptRaw ?? null,
    p_started_at: params.startedAt ?? null,
  });
  if (error) throw error;
  return data as InstallEvent;
}

// --- Type brain ---

export interface TypeBrainStats {
  type: WindowType | null;
  installCount: number;
  medianMinutes: number | null;
  avgGrade: number | null;
  recent: InstallEvent[];
}

export async function getTypeBrainStats(
  typeId: string,
): Promise<TypeBrainStats> {
  const [typeRes, eventsRes] = await Promise.all([
    supabase.from("window_types").select("*").eq("id", typeId).maybeSingle(),
    supabase
      .from("install_events")
      .select("*")
      .eq("window_type_id", typeId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (typeRes.error) throw typeRes.error;
  if (eventsRes.error) throw eventsRes.error;

  const events = eventsRes.data as InstallEvent[];
  const minutes = events
    .map((e) => e.minutes)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  const grades = events
    .map((e) => e.quality_grade)
    .filter((g): g is number => g !== null);

  const medianMinutes =
    minutes.length === 0
      ? null
      : minutes.length % 2 === 1
        ? minutes[(minutes.length - 1) / 2]
        : (minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2;

  return {
    type: typeRes.data,
    installCount: events.length,
    medianMinutes,
    avgGrade:
      grades.length === 0
        ? null
        : Math.round((grades.reduce((s, g) => s + g, 0) / grades.length) * 10) / 10,
    recent: events.slice(0, 10),
  };
}

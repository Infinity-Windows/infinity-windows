import { supabase } from "../supabase";
import type { WindowType } from "../types";
import type { DraftOpening } from "./extract";
import type {
  InstallEvent,
  MemoTopics,
  Planset,
  PlansetFormat,
  PlansetStatus,
  Profile,
  ProjectOpening,
} from "./types";

const OPENING_SELECT =
  "*, window_types(*), windows:assigned_window_id(*), projects(*), assignee:assigned_to(*)";

async function actor(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.email ?? null;
}

// --- Crew profiles ---

/** Ensure the signed-in user has a profile row; return it. */
export async function ensureMyProfile(): Promise<Profile | null> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return null;

  const { data: existing, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing as Profile;

  const displayName = (user.email ?? "installer").split("@")[0];
  const { data: created, error: insErr } = await supabase
    .from("profiles")
    .insert({ id: user.id, display_name: displayName })
    .select("*")
    .single();
  if (insErr) throw insErr;
  return created as Profile;
}

export async function getMyProfile(): Promise<Profile | null> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

export async function listProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .order("role", { ascending: false })
    .order("display_name");
  if (error) throw error;
  return data as Profile[];
}

export async function updateProfile(
  id: string,
  patch: Partial<Pick<Profile, "display_name" | "skill_level" | "role" | "active">>,
): Promise<void> {
  // Role changes go through the guarded RPC (lead-only); other fields direct.
  const { role, ...rest } = patch;
  if (role) {
    const { error } = await supabase.rpc("set_profile_role", {
      p_target: id,
      p_role: role,
    });
    if (error) throw error;
  }
  if (Object.keys(rest).length > 0) {
    const { error } = await supabase
      .from("profiles")
      .update({ ...rest, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  }
}

async function actorId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

// --- Foreman-push assignment ---

export async function assignOpeningToInstaller(
  openingId: string,
  profileId: string,
  sequence?: number | null,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("assign_opening_to_installer", {
    p_opening_id: openingId,
    p_profile_id: profileId,
    p_actor_id: await actorId(),
    p_sequence: sequence ?? null,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

export async function unassignOpening(openingId: string): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("unassign_opening", {
    p_opening_id: openingId,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

export async function startOpeningWork(openingId: string): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("start_opening_work", {
    p_opening_id: openingId,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

export async function setOpeningsSequence(openingIds: string[]): Promise<void> {
  const { error } = await supabase.rpc("set_openings_sequence", {
    p_opening_ids: openingIds,
  });
  if (error) throw error;
}

export interface InstallerTypeStat {
  installer_id: string;
  window_type_id: string;
  n: number;
  median_minutes: number | null;
  avg_grade: number | null;
  fail_rate: number | null;
  last_at: string | null;
}

/** Per-installer proven performance per type (drives learned dispatch). */
export async function listInstallerTypeStats(): Promise<InstallerTypeStat[]> {
  const { data, error } = await supabase.from("installer_type_stats").select("*");
  if (error) throw error;
  return (data ?? []) as InstallerTypeStat[];
}

/** Shape installer stats into the dispatch engine's perf lookup. */
export function buildPerfIndex(
  stats: InstallerTypeStat[],
): Record<string, Record<string, InstallerTypeStat>> {
  const idx: Record<string, Record<string, InstallerTypeStat>> = {};
  for (const s of stats) {
    (idx[s.installer_id] ??= {})[s.window_type_id] = s;
  }
  return idx;
}

export async function saveJobEstimate(
  projectId: string,
  minutes: number,
  crew: number,
): Promise<void> {
  const { error } = await supabase
    .from("projects")
    .update({
      estimated_minutes: minutes,
      estimated_crew: crew,
      estimated_at: new Date().toISOString(),
    })
    .eq("id", projectId);
  if (error) throw error;
}

export interface Clearance {
  installer_id: string;
  window_type_id: string;
  cleared_at: string;
}

export async function listClearances(): Promise<Clearance[]> {
  const { data, error } = await supabase
    .from("installer_clearance")
    .select("installer_id, window_type_id, cleared_at");
  if (error) throw error;
  return (data ?? []) as Clearance[];
}

export async function setClearance(
  installerId: string,
  windowTypeId: string,
  cleared: boolean,
): Promise<void> {
  const { error } = await supabase.rpc("set_clearance", {
    p_installer_id: installerId,
    p_window_type_id: windowTypeId,
    p_cleared: cleared,
  });
  if (error) throw error;
}

/** Openings assigned to a given installer (their work list). */
export async function listMyOpenings(
  projectId: string,
  profileId: string,
): Promise<ProjectOpening[]> {
  const { data, error } = await supabase
    .from("project_openings")
    .select(OPENING_SELECT)
    .eq("project_id", projectId)
    .eq("assigned_to", profileId)
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("opening_code");
  if (error) throw error;
  return data as ProjectOpening[];
}

/** Every opening this installer is assigned across all active jobs. */
export async function listMyOpeningsAllJobs(
  profileId: string,
): Promise<ProjectOpening[]> {
  const { data, error } = await supabase
    .from("project_openings")
    .select(OPENING_SELECT)
    .eq("assigned_to", profileId)
    .order("sequence", { ascending: true, nullsFirst: false })
    .order("opening_code");
  if (error) throw error;
  return data as ProjectOpening[];
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

/** Save the rough-opening measurement (smallest width/height already chosen). */
export async function setRoughOpening(
  openingId: string,
  widthIn: number,
  heightIn: number,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("set_opening_rough_opening", {
    p_opening_id: openingId,
    p_width_in: widthIn,
    p_height_in: heightIn,
    p_actor: await actor(),
  });
  if (error) throw error;
  return data as ProjectOpening;
}

/** Record arrival condition of the unit at the opening. Damaged flags the unit. */
export async function setOpeningCondition(
  openingId: string,
  condition: "unknown" | "ok" | "damaged",
  note?: string | null,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("set_opening_condition", {
    p_opening_id: openingId,
    p_condition: condition,
    p_note: note ?? null,
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
  estimateMinutes?: number | null;
}

export async function submitInstallEvent(
  params: SubmitInstallParams,
): Promise<InstallEvent> {
  const { data, error } = await supabase.rpc("submit_install_event", {
    p_opening_id: params.openingId,
    p_installer: await actor(),
    p_installer_id: await actorId(),
    p_minutes: params.minutes ?? null,
    p_estimate_minutes: params.estimateMinutes ?? null,
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
  p90Minutes: number | null;
  avgGrade: number | null;
  failRate: number | null;
  outcomeDifficulty: number | null;
  tips: string[];
  watchOuts: string[];
  recent: InstallEvent[];
  photos: { id: string; storage_path: string; signedUrl: string | null }[];
  voiceMemos: { id: string; storage_path: string; signedUrl: string | null; created_at: string }[];
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function signedMedia(
  storagePath: string,
): Promise<string | null> {
  const slash = storagePath.indexOf("/");
  const bucket = slash >= 0 ? storagePath.slice(0, slash) : "install-media";
  const path = slash >= 0 ? storagePath.slice(slash + 1) : storagePath;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 3600);
  if (error) return null;
  return data.signedUrl;
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
  const fails = grades.filter((g) => g <= 2).length;

  const eventIds = events.map((e) => e.id);
  let photos: TypeBrainStats["photos"] = [];
  let voiceMemos: TypeBrainStats["voiceMemos"] = [];
  if (eventIds.length > 0) {
    const { data: media, error: mediaErr } = await supabase
      .from("attachments")
      .select("id, kind, storage_path, created_at, install_event_id")
      .in("install_event_id", eventIds.slice(0, 50))
      .in("kind", ["photo", "voice_memo"])
      .order("created_at", { ascending: false })
      .limit(30);
    if (mediaErr) throw mediaErr;
    const photoRows = (media ?? []).filter((m) => m.kind === "photo").slice(0, 12);
    const voiceRows = (media ?? []).filter((m) => m.kind === "voice_memo").slice(0, 5);
    photos = await Promise.all(
      photoRows.map(async (m) => ({
        id: m.id,
        storage_path: m.storage_path,
        signedUrl: await signedMedia(m.storage_path),
      })),
    );
    voiceMemos = await Promise.all(
      voiceRows.map(async (m) => ({
        id: m.id,
        storage_path: m.storage_path,
        signedUrl: await signedMedia(m.storage_path),
        created_at: m.created_at,
      })),
    );
  }

  const type = typeRes.data as WindowType | null;
  const tips = Array.isArray(type?.tips_json) ? type!.tips_json! : [];
  const watchOuts = Array.isArray(type?.watch_outs_json)
    ? type!.watch_outs_json!
    : [];

  // Prefer the persisted rollups (same numbers dispatch + estimates use);
  // fall back to live computation when the trigger hasn't populated them yet.
  const liveMedian = percentile(minutes, 0.5);
  const liveP90 = percentile(minutes, 0.9);
  const liveAvg =
    grades.length === 0
      ? null
      : Math.round((grades.reduce((s, g) => s + g, 0) / grades.length) * 10) / 10;
  const liveFail =
    grades.length === 0 ? null : Math.round((fails / grades.length) * 1000) / 10;

  return {
    type,
    installCount: type?.n_installs ?? events.length,
    medianMinutes: type?.median_minutes ?? liveMedian,
    p90Minutes: type?.p90_minutes ?? liveP90,
    avgGrade: type?.avg_grade ?? liveAvg,
    failRate: type?.fail_rate ?? liveFail,
    outcomeDifficulty:
      type?.learned_difficulty ??
      type?.outcome_difficulty ??
      type?.difficulty_rating ??
      null,
    tips: tips.slice(0, 5),
    watchOuts: watchOuts.slice(0, 5),
    recent: events.slice(0, 10),
    photos,
    voiceMemos,
  };
}

/** Invoke Edge Function to extract schedule rows via GPT when deterministic parse finds nothing. */
export async function aiExtractSchedule(
  pages: { pageNumber: number; text: string }[],
  catalog: { type_code: string; name: string }[],
): Promise<ScheduleRowLike[]> {
  const { data, error } = await supabase.functions.invoke("extract-schedule", {
    body: { pages, catalog },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return (data?.rows ?? []) as ScheduleRowLike[];
}

export interface ScheduleRowLike {
  openingCode: string;
  typeText: string;
  qty: number;
  label: string | null;
  pageNumber: number;
}

/** Invoke tip synthesis for one type (or all eligible types when typeId omitted). */
export async function synthesizeTypeTips(
  typeId?: string,
): Promise<{ results: { type_code: string; updated: boolean; installs: number }[] }> {
  const { data, error } = await supabase.functions.invoke("synthesize-type-tips", {
    body: typeId ? { type_id: typeId, min_installs: 3 } : { min_installs: 3 },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data as {
    results: { type_code: string; updated: boolean; installs: number }[];
  };
}

/** Fire-and-forget transcription after a voice attachment lands. */
export async function requestTranscription(attachmentId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("transcribe-install-memo", {
    body: { attachment_id: attachmentId },
  });
  if (error) {
    console.warn("transcribe invoke failed", error);
  }
}

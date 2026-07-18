import { supabase } from "../supabase";
import type { WindowType } from "../types";
import type { DraftOpening } from "./extract";
import { markBase } from "./extract";
import type {
  InstallEvent,
  MemoTopics,
  PlanOutline,
  Planset,
  PlansetFormat,
  PlansetKind,
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

// Never select `pin` to the client; it's verified server-side via RPC.
const PROFILE_COLS = "id, display_name, skill_level, role, active, created_at, updated_at";

/** Emails that auto-promote to Owner on first/any sign-in. */
const OWNER_BOOTSTRAP_EMAILS = new Set([
  "ammon@horizonsolarusa.com",
  "isaacammonbarlow@gmail.com",
]);

function isOwnerBootstrapEmail(email: string | undefined): boolean {
  return OWNER_BOOTSTRAP_EMAILS.has((email ?? "").trim().toLowerCase());
}

/** Ensure the signed-in user has a profile row; return it. */
export async function ensureMyProfile(): Promise<Profile | null> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return null;

  const { data: existing, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLS)
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;

  const bootstrapOwner = isOwnerBootstrapEmail(user.email);

  let profile = existing as Profile | null;
  if (!profile) {
    const displayName = bootstrapOwner
      ? "Ammon"
      : (user.email ?? "installer").split("@")[0];
    const { data: created, error: insErr } = await supabase
      .from("profiles")
      .insert({
        id: user.id,
        display_name: displayName,
        ...(bootstrapOwner ? { role: "owner", active: true } : {}),
      })
      .select(PROFILE_COLS)
      .single();
    if (insErr) throw insErr;
    profile = created as Profile;
  }

  // Bootstrap: promote Ammon bootstrap emails to Owner (full access).
  if (
    bootstrapOwner &&
    (profile.role !== "owner" ||
      profile.display_name !== "Ammon" ||
      !profile.active)
  ) {
    const { data: promoted, error: promoErr } = await supabase
      .from("profiles")
      .update({
        role: "owner",
        display_name: "Ammon",
        active: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id)
      .select(PROFILE_COLS)
      .single();
    if (promoErr) throw promoErr;
    profile = promoted as Profile;
  }

  return profile;
}

export async function getMyProfile(): Promise<Profile | null> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) {
    const { BYPASS_PROFILE, isAuthBypassed } = await import("../authBypass");
    return isAuthBypassed() ? BYPASS_PROFILE : null;
  }
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLS)
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  return data as Profile | null;
}

export async function listProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLS)
    .order("role", { ascending: false })
    .order("display_name");
  if (error) throw error;
  return data as Profile[];
}

/** PIN status/verify happen server-side; the value never reaches the client. */
export async function myPinStatus(): Promise<boolean> {
  const { data, error } = await supabase.rpc("my_pin_status");
  if (error) return false;
  return Boolean(data);
}

export async function checkMyPin(pin: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("check_my_pin", { p_pin: pin });
  if (error) return false;
  return Boolean(data);
}

export interface AccessRequest {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  requested_role: string;
  note: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
}

export async function submitAccessRequest(payload: {
  name: string;
  email?: string;
  phone?: string;
  requested_role?: string;
  note?: string;
}): Promise<void> {
  const { error } = await supabase.from("access_requests").insert({
    name: payload.name,
    email: payload.email ?? null,
    phone: payload.phone ?? null,
    requested_role: payload.requested_role ?? "installer",
    note: payload.note ?? null,
  });
  if (error) throw error;
}

export async function listAccessRequests(): Promise<AccessRequest[]> {
  const { data, error } = await supabase
    .from("access_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as AccessRequest[];
}

export async function decideAccessRequest(
  id: string,
  status: "approved" | "denied",
): Promise<void> {
  const { error } = await supabase
    .from("access_requests")
    .update({ status, decided_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function setMyPin(pin: string): Promise<void> {
  const { error } = await supabase.rpc("set_my_pin", { p_pin: pin });
  if (error) throw error;
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

/** Flag an opening to the lead with a reason (empty note clears the flag). */
export async function flagOpening(
  openingId: string,
  note: string | null,
): Promise<ProjectOpening> {
  const { data, error } = await supabase.rpc("flag_opening", {
    p_opening_id: openingId,
    p_note: note,
  });
  if (error) throw error;
  return data as ProjectOpening;
}

export interface JobNote {
  id: string;
  project_id: string;
  author_name: string | null;
  note: string;
  created_at: string;
}

export async function addJobNote(projectId: string, note: string): Promise<void> {
  const { error } = await supabase.rpc("add_job_note", {
    p_project_id: projectId,
    p_note: note,
  });
  if (error) throw error;
}

export async function listJobNotes(projectId: string): Promise<JobNote[]> {
  const { data, error } = await supabase
    .from("job_notes")
    .select("id, project_id, author_name, note, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as JobNote[];
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

export interface InstallerLeaderRow {
  installer_id: string;
  display_name: string;
  installs: number;
  median_minutes: number | null;
  avg_grade: number | null;
  fail_rate: number | null;
}

/** Company analytics: per-installer install counts, speed, quality. */
export async function getInstallerLeaderboard(): Promise<InstallerLeaderRow[]> {
  const [profilesRes, eventsRes] = await Promise.all([
    supabase.from("profiles").select("id, display_name"),
    supabase
      .from("install_events")
      .select("installer_id, minutes, quality_grade")
      .not("installer_id", "is", null),
  ]);
  if (profilesRes.error) throw profilesRes.error;
  if (eventsRes.error) throw eventsRes.error;

  const nameById = new Map(
    (profilesRes.data ?? []).map((p) => [p.id, p.display_name]),
  );
  const byInstaller = new Map<
    string,
    { minutes: number[]; grades: number[] }
  >();
  for (const e of eventsRes.data ?? []) {
    if (!e.installer_id) continue;
    const b = byInstaller.get(e.installer_id) ?? { minutes: [], grades: [] };
    if (e.minutes != null) b.minutes.push(e.minutes);
    if (e.quality_grade != null) b.grades.push(e.quality_grade);
    byInstaller.set(e.installer_id, b);
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const rows: InstallerLeaderRow[] = [];
  for (const [id, b] of byInstaller) {
    const installs = Math.max(b.minutes.length, b.grades.length);
    const fails = b.grades.filter((g) => g <= 2).length;
    rows.push({
      installer_id: id,
      display_name: nameById.get(id) ?? "unknown",
      installs,
      median_minutes: median(b.minutes),
      avg_grade:
        b.grades.length === 0
          ? null
          : Math.round((b.grades.reduce((s, g) => s + g, 0) / b.grades.length) * 10) / 10,
      fail_rate:
        b.grades.length === 0 ? null : Math.round((fails / b.grades.length) * 1000) / 10,
    });
  }
  return rows.sort((a, b) => b.installs - a.installs);
}

export interface JobVarianceRow {
  id: string;
  job_code: string;
  name: string;
  estimated_minutes: number | null;
  actual_minutes: number;
  installed: number;
  openings: number;
}

/** Estimate-vs-actual per job (bid accuracy). */
export async function getJobVariance(): Promise<JobVarianceRow[]> {
  const { data: projects, error: pErr } = await supabase
    .from("projects")
    .select("id, job_code, name, estimated_minutes");
  if (pErr) throw pErr;

  const { data: openings, error: oErr } = await supabase
    .from("project_openings")
    .select("project_id, status");
  if (oErr) throw oErr;

  const { data: events, error: eErr } = await supabase
    .from("install_events")
    .select("minutes, project_opening_id");
  if (eErr) throw eErr;

  // Map opening -> project to attribute actual minutes.
  const openingProject = new Map<string, string>();
  const openingCounts = new Map<string, { installed: number; total: number }>();
  for (const o of openings ?? []) {
    const c = openingCounts.get(o.project_id) ?? { installed: 0, total: 0 };
    c.total += 1;
    if (o.status === "installed") c.installed += 1;
    openingCounts.set(o.project_id, c);
  }

  const { data: openingRows } = await supabase
    .from("project_openings")
    .select("id, project_id");
  for (const o of openingRows ?? []) openingProject.set(o.id, o.project_id);

  const actualByProject = new Map<string, number>();
  for (const e of events ?? []) {
    const pid = openingProject.get(e.project_opening_id);
    if (pid && e.minutes != null) {
      actualByProject.set(pid, (actualByProject.get(pid) ?? 0) + e.minutes);
    }
  }

  return (projects ?? []).map((p) => {
    const c = openingCounts.get(p.id) ?? { installed: 0, total: 0 };
    return {
      id: p.id,
      job_code: p.job_code,
      name: p.name,
      estimated_minutes: p.estimated_minutes ?? null,
      actual_minutes: actualByProject.get(p.id) ?? 0,
      installed: c.installed,
      openings: c.total,
    };
  });
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

/** Count of this installer's assigned, not-yet-installed openings (nav badge). */
export async function countMyOpenOpenings(profileId: string): Promise<number> {
  const { count, error } = await supabase
    .from("project_openings")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to", profileId)
    .neq("status", "installed");
  if (error) return 0;
  return count ?? 0;
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
  kind: PlansetKind = "building",
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
      kind,
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

// --- Manual plan outlines ---

const LOCAL_OUTLINES_KEY = "infinity.planOutlines.v1";

function isMissingOutlineTable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "PGRST205") return true;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return message.includes("project_plan_outlines");
}

function isMissingFeaturesColumn(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  return e.code === "PGRST204" && message.includes("features");
}

function readLocalOutlines(): PlanOutline[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOCAL_OUTLINES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        try {
          return parseOutlineRow(row as Parameters<typeof parseOutlineRow>[0]);
        } catch {
          return null;
        }
      })
      .filter((row): row is PlanOutline => !!row);
  } catch {
    return [];
  }
}

function writeLocalOutlines(rows: PlanOutline[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LOCAL_OUTLINES_KEY, JSON.stringify(rows));
}

function listLocalOutlines(
  projectId: string,
  plansetId?: string,
): PlanOutline[] {
  return readLocalOutlines()
    .filter(
      (row) =>
        row.project_id === projectId &&
        (!plansetId || row.planset_id === plansetId),
    )
    .sort(
      (a, b) =>
        a.page_number - b.page_number ||
        a.created_at.localeCompare(b.created_at),
    );
}

function saveLocalOutline(args: {
  outlineId?: string;
  projectId: string;
  plansetId: string;
  pageNumber: number;
  points: { x: number; y: number }[];
  pageAspect: number;
  features?: unknown;
}): PlanOutline {
  const now = new Date().toISOString();
  const rows = readLocalOutlines();
  if (args.outlineId) {
    const idx = rows.findIndex((row) => row.id === args.outlineId);
    if (idx >= 0) {
      const next: PlanOutline = {
        ...rows[idx],
        project_id: args.projectId,
        planset_id: args.plansetId,
        page_number: args.pageNumber,
        points: args.points,
        page_aspect: args.pageAspect,
        features: args.features ?? rows[idx].features ?? {},
        updated_at: now,
      };
      rows[idx] = next;
      writeLocalOutlines(rows);
      return next;
    }
  }
  const created: PlanOutline = {
    id: args.outlineId ?? crypto.randomUUID(),
    project_id: args.projectId,
    planset_id: args.plansetId,
    page_number: args.pageNumber,
    points: args.points,
    page_aspect: args.pageAspect,
    features: args.features ?? {},
    created_at: now,
    updated_at: now,
  };
  writeLocalOutlines([...rows, created]);
  return created;
}

function deleteLocalOutline(
  plansetId: string,
  pageNumber: number,
  outlineId?: string,
): void {
  writeLocalOutlines(
    readLocalOutlines().filter((row) => {
      if (row.planset_id !== plansetId || row.page_number !== pageNumber) {
        return true;
      }
      if (outlineId) return row.id !== outlineId;
      return false;
    }),
  );
}

function parseOutlineRow(row: {
  id: string;
  project_id: string;
  planset_id: string;
  page_number: number;
  points: unknown;
  page_aspect: number | string;
  features?: unknown;
  created_at: string;
  updated_at: string;
}): PlanOutline {
  const raw = Array.isArray(row.points) ? row.points : [];
  const points = raw
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const x = Number((p as { x?: unknown }).x);
      const y = Number((p as { y?: unknown }).y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
      };
    })
    .filter((p): p is { x: number; y: number } => !!p);
  return {
    id: row.id,
    project_id: row.project_id,
    planset_id: row.planset_id,
    page_number: row.page_number,
    points,
    page_aspect: Number(row.page_aspect) || 0.7,
    features: row.features ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listPlanOutlines(
  projectId: string,
  plansetId?: string,
): Promise<PlanOutline[]> {
  let q = supabase
    .from("project_plan_outlines")
    .select("*")
    .eq("project_id", projectId)
    .order("page_number")
    .order("created_at");
  if (plansetId) q = q.eq("planset_id", plansetId);
  const { data, error } = await q;
  if (error) {
    if (isMissingOutlineTable(error)) {
      return listLocalOutlines(projectId, plansetId);
    }
    throw error;
  }
  const remote = (data ?? []).map(parseOutlineRow);
  // Keep any browser-local drafts until the DB table is available everywhere.
  const local = listLocalOutlines(projectId, plansetId);
  if (local.length === 0) return remote;
  const byId = new Map(remote.map((row) => [row.id, row]));
  for (const row of local) byId.set(row.id, row);
  return [...byId.values()].sort(
    (a, b) =>
      a.page_number - b.page_number ||
      a.created_at.localeCompare(b.created_at),
  );
}

export async function savePlanOutline(args: {
  outlineId?: string;
  projectId: string;
  plansetId: string;
  pageNumber: number;
  points: { x: number; y: number }[];
  pageAspect: number;
  features?: unknown;
}): Promise<PlanOutline> {
  const values: Record<string, unknown> = {
    project_id: args.projectId,
    planset_id: args.plansetId,
    page_number: args.pageNumber,
    points: args.points,
    page_aspect: args.pageAspect,
    updated_at: new Date().toISOString(),
  };
  if (args.features !== undefined) values.features = args.features;
  const run = async (vals: Record<string, unknown>) => {
    const query = args.outlineId
      ? supabase
          .from("project_plan_outlines")
          .update(vals)
          .eq("id", args.outlineId)
      : supabase.from("project_plan_outlines").insert(vals);
    return query.select("*").single();
  };
  let { data, error } = await run(values);
  if (error && "features" in values && isMissingFeaturesColumn(error)) {
    // DB has the table but not the newer features column yet.
    const { features: _skipped, ...withoutFeatures } = values;
    ({ data, error } = await run(withoutFeatures));
  }
  if (error) {
    if (isMissingOutlineTable(error)) {
      return saveLocalOutline(args);
    }
    throw error;
  }
  const saved = parseOutlineRow(data);
  // Drop the local copy once the row is on the server.
  deleteLocalOutline(args.plansetId, args.pageNumber, saved.id);
  return saved;
}

export async function deletePlanOutline(
  plansetId: string,
  pageNumber: number,
  outlineId?: string,
): Promise<void> {
  let query = supabase
    .from("project_plan_outlines")
    .delete()
    .eq("planset_id", plansetId)
    .eq("page_number", pageNumber);
  if (outlineId) query = query.eq("id", outlineId);
  const { error } = await query;
  if (error) {
    if (isMissingOutlineTable(error)) {
      deleteLocalOutline(plansetId, pageNumber, outlineId);
      return;
    }
    throw error;
  }
  deleteLocalOutline(plansetId, pageNumber, outlineId);
}

/** True when we can render this planset as a PDF in the app. */
export function plansetIsViewable(planset: Planset): boolean {
  return Boolean(
    planset.converted_pdf_path || planset.source_format === "pdf",
  );
}

/** Signed URL for opening/downloading the stored file (1 hour). */
export async function getPlansetSignedUrl(
  planset: Planset,
): Promise<string> {
  const path = planset.converted_pdf_path ?? planset.storage_path;
  const { data, error } = await supabase.storage
    .from("plansets")
    .createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
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
 *
 * Manually placed pins on unconfirmed drafts are preserved across re-extract
 * when the same opening_code comes back.
 */
export async function saveDraftOpenings(
  projectId: string,
  plansetId: string,
  drafts: DraftOpening[],
): Promise<{ inserted: number; skipped: number }> {
  if (drafts.length === 0) return { inserted: 0, skipped: 0 };

  const { data: existing, error: exErr } = await supabase
    .from("project_openings")
    .select("id, opening_code, confirmed, status, pin_x, pin_y, page_number")
    .eq("project_id", projectId);
  if (exErr) throw exErr;

  // Protected = confirmed OR already progressed past planning (assigned /
  // installed). Only untouched drafts are replaced by a re-extract.
  const isProtected = (o: { confirmed: boolean; status: string }) =>
    o.confirmed || o.status !== "planned";
  const confirmedCodes = new Set(
    existing.filter(isProtected).map((o) => o.opening_code),
  );
  const preservedPins = new Map<
    string,
    { pin_x: number; pin_y: number; page_number: number }
  >();
  for (const o of existing) {
    if (isProtected(o)) continue;
    if (o.pin_x == null || o.pin_y == null) continue;
    preservedPins.set(o.opening_code, {
      pin_x: Number(o.pin_x),
      pin_y: Number(o.pin_y),
      page_number: o.page_number,
    });
  }
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
    fresh.map((d) => {
      const kept = preservedPins.get(d.opening_code);
      return {
        project_id: projectId,
        planset_id: plansetId,
        opening_code: d.opening_code,
        window_type_id: d.window_type_id,
        label: d.label,
        page_number: kept?.page_number ?? d.page_number,
        pin_x: kept?.pin_x ?? d.pin_x ?? null,
        pin_y: kept?.pin_y ?? d.pin_y ?? null,
        confirmed: false,
      };
    }),
  );
  if (error) throw error;
  return { inserted: fresh.length, skipped };
}

/**
 * Upsert catalog types from a specs extract so mark #14 becomes a real
 * window_types row (type_code = 14) with size/color/category when known.
 * Then patch drafts that still lack a window_type_id.
 */
export async function ensureTypesFromSpecs(
  drafts: DraftOpening[],
): Promise<DraftOpening[]> {
  if (drafts.length === 0) return drafts;

  const byMark = new Map<string, DraftOpening>();
  for (const d of drafts) {
    if (!byMark.has(d.mark_code)) byMark.set(d.mark_code, d);
  }

  const { data: existing, error: listErr } = await supabase
    .from("window_types")
    .select("id, type_code, name, category, width_in, height_in, notes");
  if (listErr) throw listErr;

  const byCode = new Map(
    (existing ?? []).map((t) => [t.type_code.toUpperCase(), t]),
  );
  const markToTypeId = new Map<string, string>();

  for (const [mark, sample] of byMark) {
    const code = mark.toUpperCase();
    let row = byCode.get(code);
    const category =
      sample.kind === "door" ? "door" : sample.kind === "window" ? "window" : null;
    const notesParts = [
      sample.color ? `Color: ${sample.color}` : null,
      sample.type_text && sample.type_text !== code
        ? `Spec: ${sample.type_text}`
        : null,
    ].filter(Boolean);
    const notes = notesParts.length ? notesParts.join(" · ") : null;
    const name =
      sample.type_text && sample.type_text !== code
        ? `${sample.type_text} (#${mark})`
        : `Mark #${mark}`;

    if (!row) {
      const { data: created, error: insErr } = await supabase
        .from("window_types")
        .insert({
          type_code: code,
          name,
          category,
          width_in: sample.width_in,
          height_in: sample.height_in,
          notes,
        })
        .select("id, type_code")
        .single();
      if (insErr) throw insErr;
      row = {
        id: created.id,
        type_code: created.type_code,
        name,
        category,
        width_in: sample.width_in,
        height_in: sample.height_in,
        notes,
      };
      byCode.set(code, row);
    } else {
      // Fill gaps only — never overwrite a catalog product's known dims.
      const patch: Record<string, unknown> = {};
      if (row.width_in == null && sample.width_in != null) {
        patch.width_in = sample.width_in;
      }
      if (row.height_in == null && sample.height_in != null) {
        patch.height_in = sample.height_in;
      }
      if (!row.category && category) patch.category = category;
      if (notes && !(row as { notes?: string | null }).notes) patch.notes = notes;
      if (Object.keys(patch).length > 0) {
        const { error: upErr } = await supabase
          .from("window_types")
          .update(patch)
          .eq("id", row.id);
        if (upErr) throw upErr;
      }
    }
    markToTypeId.set(mark, row.id);
  }

  return drafts.map((d) => ({
    ...d,
    window_type_id: d.window_type_id ?? markToTypeId.get(d.mark_code) ?? null,
  }));
}

/**
 * Link a specs extract onto openings already on the job (by base mark).
 * Only updates unconfirmed / planned drafts' window_type_id when empty or
 * when force-linking from a fresh specs upload.
 */
export async function linkSpecsToOpenings(
  projectId: string,
  drafts: DraftOpening[],
): Promise<{ linked: number }> {
  if (drafts.length === 0) return { linked: 0 };

  const markToType = new Map<string, string>();
  for (const d of drafts) {
    if (d.window_type_id) markToType.set(d.mark_code, d.window_type_id);
  }
  if (markToType.size === 0) return { linked: 0 };

  const { data: openings, error } = await supabase
    .from("project_openings")
    .select("id, opening_code, window_type_id, confirmed, status")
    .eq("project_id", projectId);
  if (error) throw error;

  let linked = 0;
  for (const o of openings ?? []) {
    if (o.confirmed || o.status !== "planned") continue;
    const mark = markBase(o.opening_code);
    const typeId = markToType.get(mark);
    if (!typeId) continue;
    if (o.window_type_id === typeId) continue;
    const { error: upErr } = await supabase
      .from("project_openings")
      .update({ window_type_id: typeId })
      .eq("id", o.id);
    if (upErr) throw upErr;
    linked += 1;
  }
  return { linked };
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
    planset_id?: string | null;
    pin_x?: number | null;
    pin_y?: number | null;
    /** Manual map dots stay confirmed so re-extract will not wipe them. */
    confirmed?: boolean;
  },
): Promise<ProjectOpening> {
  const { confirmed = true, ...rest } = opening;
  const { data, error } = await supabase
    .from("project_openings")
    .insert({ project_id: projectId, confirmed, ...rest })
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

/**
 * Undo/reclaim an install (foreman+). Voids the install event (keeps history),
 * reverts the opening to assigned/planned, returns the unit to the truck, and
 * voids any points. Server-side guard blocks plain installers.
 */
export async function undoInstall(
  openingId: string,
  reason?: string,
): Promise<void> {
  const { error } = await supabase.rpc("undo_install", {
    p_opening_id: openingId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

export interface FailedInstall {
  event_id: string;
  opening_id: string;
  opening_code: string;
  installer: string | null;
  voided_at: string;
  void_reason: string | null;
  voided_by_name: string | null;
  created_at: string;
}

export interface ProjectExceptions {
  /** Installs that were undone/reverted — data preserved for review. */
  failedInstalls: FailedInstall[];
  /** Openings a crew member flagged for the lead, or that arrived damaged. */
  flaggedOpenings: ProjectOpening[];
}

/**
 * Opening ids on a project that carry a voided (failed/undone) install event.
 * Failed-install visibility is foreman+ only, so callers pass `canSee` (their
 * foreman+ guard); a non-foreman caller short-circuits to an empty set and
 * never fetches the data. (Full RLS hardening is a later follow-up.)
 */
export async function listVoidedInstallOpeningIds(
  projectId: string,
  canSee = true,
): Promise<Set<string>> {
  if (!canSee) return new Set<string>();
  const { data, error } = await supabase
    .from("install_events")
    .select("project_opening_id, project_openings:project_opening_id!inner(project_id)")
    .not("voided_at", "is", null)
    .eq("project_openings.project_id", projectId);
  if (error) throw error;
  const rows = (data ?? []) as unknown as { project_opening_id: string }[];
  return new Set(rows.map((r) => r.project_opening_id));
}

/**
 * Exceptions view for foreman+: failed/undone installs (preserved), flagged
 * openings, and damaged-condition openings on this job.
 */
export async function listProjectExceptions(
  projectId: string,
  canSee = true,
): Promise<ProjectExceptions> {
  if (!canSee) return { failedInstalls: [], flaggedOpenings: [] };
  const [flaggedRes, voidedRes] = await Promise.all([
    supabase
      .from("project_openings")
      .select(OPENING_SELECT)
      .eq("project_id", projectId)
      .or("flag_note.not.is.null,condition.eq.damaged")
      .order("opening_code"),
    supabase
      .from("install_events")
      .select(
        "id, installer, voided_at, void_reason, created_at, project_opening_id, " +
          "project_openings:project_opening_id!inner(opening_code, project_id), " +
          "voided_by_profile:voided_by(display_name)",
      )
      .not("voided_at", "is", null)
      .eq("project_openings.project_id", projectId)
      .order("voided_at", { ascending: false }),
  ]);
  if (flaggedRes.error) throw flaggedRes.error;
  if (voidedRes.error) throw voidedRes.error;

  type VoidedRow = {
    id: string;
    installer: string | null;
    voided_at: string;
    void_reason: string | null;
    created_at: string;
    project_opening_id: string;
    project_openings: { opening_code: string } | null;
    voided_by_profile: { display_name: string } | null;
  };
  const voidedRows = (voidedRes.data ?? []) as unknown as VoidedRow[];

  const failedInstalls: FailedInstall[] = voidedRows.map((e) => ({
    event_id: e.id,
    opening_id: e.project_opening_id,
    opening_code: e.project_openings?.opening_code ?? "?",
    installer: e.installer ?? null,
    voided_at: e.voided_at,
    void_reason: e.void_reason ?? null,
    voided_by_name: e.voided_by_profile?.display_name ?? null,
    created_at: e.created_at,
  }));

  return {
    failedInstalls,
    flaggedOpenings: (flaggedRes.data ?? []) as ProjectOpening[],
  };
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
  videos: { id: string; signedUrl: string | null }[];
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
  let videos: TypeBrainStats["videos"] = [];
  if (eventIds.length > 0) {
    const goldenId = (typeRes.data as WindowType | null)?.golden_install_event_id;
    const { data: media, error: mediaErr } = await supabase
      .from("attachments")
      .select("id, kind, storage_path, created_at, install_event_id")
      .in("install_event_id", eventIds.slice(0, 50))
      .in("kind", ["photo", "voice_memo", "video"])
      .order("created_at", { ascending: false })
      .limit(40);
    if (mediaErr) throw mediaErr;
    const photoRows = (media ?? []).filter((m) => m.kind === "photo").slice(0, 12);
    const voiceRows = (media ?? []).filter((m) => m.kind === "voice_memo").slice(0, 5);
    // Prefer the golden install's video first.
    const videoRows = (media ?? [])
      .filter((m) => m.kind === "video")
      .sort((a, b) =>
        (b.install_event_id === goldenId ? 1 : 0) -
        (a.install_event_id === goldenId ? 1 : 0),
      )
      .slice(0, 3);
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
    videos = await Promise.all(
      videoRows.map(async (m) => ({
        id: m.id,
        signedUrl: await signedMedia(m.storage_path),
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
    videos,
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
  widthIn?: number | null;
  heightIn?: number | null;
  color?: string | null;
  kind?: "window" | "door";
}

/** Install events by this installer whose AI-filled memo still needs a glance. */
export async function listMemosToConfirm(
  installerId: string,
): Promise<InstallEvent[]> {
  const { data, error } = await supabase
    .from("install_events")
    .select("*, window_types(type_code, name)")
    .eq("installer_id", installerId)
    .not("transcript_raw", "is", null)
    .eq("ai_confirmed", false)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as InstallEvent[];
}

export async function confirmInstallMemo(
  eventId: string,
  patch: Partial<MemoTopics> & { quality_grade?: number | null },
): Promise<void> {
  const { error } = await supabase
    .from("install_events")
    .update({ ...patch, ai_confirmed: true })
    .eq("id", eventId);
  if (error) throw error;
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

/** Generate/refresh the AI how-to for a type from its golden install + tips. */
export async function generateHowto(typeId: string): Promise<void> {
  const { error } = await supabase.functions.invoke("generate-howto", {
    body: { type_id: typeId },
  });
  if (error) throw error;
}

/** Lead-editable knowledge on a type (tips, watch-outs, how-to steps). */
export async function updateTypeKnowledge(
  typeId: string,
  patch: {
    tips_json?: string[];
    watch_outs_json?: string[];
    howto_json?: import("../types").HowtoStep[];
  },
): Promise<void> {
  const { error } = await supabase.from("window_types").update(patch).eq("id", typeId);
  if (error) throw error;
}

export async function setGoldenInstall(
  typeId: string,
  eventId: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_golden_install", {
    p_type_id: typeId,
    p_event_id: eventId,
  });
  if (error) throw error;
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

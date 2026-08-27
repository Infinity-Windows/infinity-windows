// Client seam for the Infinity AI knowledge base (vault RAG). The pure logic
// (chunking, hashing, retrieval shaping, prompt assembly, the fallback
// decision) lives in the runtime-agnostic shared module so the browser, the
// Deno edge functions and the tests all share one implementation.
import { supabase, supabaseConfigured } from "./supabase";
import {
  deriveTitle,
  type KnowledgeSource,
} from "../../../supabase/functions/_shared/knowledge.ts";
import { orderMyWork } from "./dispatch";
import { areaKey, toDispatchOpening } from "./install/nextOpening";
import { isInstallInProgress } from "./install/installTimer";
import {
  isForemanPlus,
  isSupervisorPlus,
  type CrewRole,
  type ProjectOpening,
} from "./install/types";
import { compareIssues, KIND_LABELS, URGENCY_MARK, type Issue } from "./issues";
import { buildAgenda, crewmateNames } from "./schedule/grouping";
import { addDaysISO, agendaDayLabel, formatStartTime } from "./schedule/dates";
import type { ScheduleAssignment } from "./schedule/types";
import { serviceBadge, serviceLevel } from "./vehicles/service";
import { vehicleTitle } from "./vehicles/display";
import type { ScheduleVehicleLink, VehicleWithMeta } from "./vehicles/types";
import { tripPhase } from "./travel/status";
import type { Trip } from "./travel/types";
import type { Project } from "./types";
import { formatApiError } from "./errors";

export {
  chunkMarkdown,
  dedupeSources,
  deriveTitle,
  formatSourcesLine,
  hashContent,
  shapeMatches,
  shouldUseLLM,
  type KnowledgeSource,
} from "../../../supabase/functions/_shared/knowledge.ts";

export interface VaultNote {
  path: string;
  title: string;
  content: string;
}

/**
 * A Supabase Edge Function non-2xx surfaces as a generic FunctionsHttpError
 * whose real message lives in the (unparsed) Response on `.context`. Pull our
 * clear `{ error }` body out so wrong-PIN / role errors reach the UI verbatim.
 */
async function functionError(error: unknown): Promise<Error> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = await ctx.json();
      if (body?.error) return new Error(String(body.error));
    } catch {
      // fall through to the generic message
    }
  }
  return error instanceof Error ? error : new Error(formatApiError(error));
}

export interface AskResult {
  answer: string;
  sources: KnowledgeSource[];
  /**
   * True when the server declined to pay for an AI answer — the asker isn't a
   * foreman, they've used today's questions, or the company hit its monthly
   * ceiling. NOT an error: `answer` is deliberately empty so the caller serves
   * the bundled company brain, and `note` is one quiet line explaining why the
   * answer came from there. See docs/ai-spend-limits.md.
   */
  limited?: boolean;
  note?: string;
  /**
   * Wave A4: plain progress lines for any scheduling tools the model called
   * along the way ("Reading the week…", "Drafting 6 assignments…") — built
   * server-side from the tool calls it actually made. Absent when it called
   * none, which is most questions.
   */
  toolActivity?: string[];
}

/** Ask the cloud `ask` function for a real, grounded answer. Throws on any
 * failure so the caller can fall back to the bundled offline brain. */
export async function askInfinity(
  question: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
): Promise<AskResult> {
  const { data, error } = await supabase.functions.invoke("ask", {
    body: { question, history },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  const toolActivity = Array.isArray(data?.toolActivity)
    ? (data.toolActivity as unknown[]).filter((l): l is string => typeof l === "string")
    : [];
  return {
    answer: String(data?.answer ?? "").trim(),
    sources: Array.isArray(data?.sources) ? (data.sources as KnowledgeSource[]) : [],
    ...(data?.limited ? { limited: true } : {}),
    ...(typeof data?.note === "string" && data.note ? { note: data.note } : {}),
    ...(toolActivity.length > 0 ? { toolActivity } : {}),
  };
}

export interface IngestSummary {
  docsAdded: number;
  docsUpdated: number;
  docsUnchanged: number;
  docsRemoved: number;
  chunks: number;
}

const emptySummary = (): IngestSummary => ({
  docsAdded: 0,
  docsUpdated: 0,
  docsUnchanged: 0,
  docsRemoved: 0,
  chunks: 0,
});

// Page uploads so a big vault never blows a single function invocation's
// payload/time budget: at most this many notes, and this many characters, per
// call. The client keeps calling until the whole vault is sent.
const MAX_FILES_PER_PAGE = 12;
const MAX_CHARS_PER_PAGE = 300_000;

/** Split notes into upload pages bounded by file count and total size. */
export function pageNotes(
  notes: VaultNote[],
  maxFiles = MAX_FILES_PER_PAGE,
  maxChars = MAX_CHARS_PER_PAGE,
): VaultNote[][] {
  const pages: VaultNote[][] = [];
  let current: VaultNote[] = [];
  let chars = 0;
  for (const note of notes) {
    const size = note.content.length;
    const wouldOverflow =
      current.length > 0 && (current.length >= maxFiles || chars + size > maxChars);
    if (wouldOverflow) {
      pages.push(current);
      current = [];
      chars = 0;
    }
    current.push(note);
    chars += size;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

/**
 * Send a vault to the `ingest-knowledge` function, paged. Every call is
 * PIN-gated server-side, so the owner-set vault `pin` is threaded into each
 * request. `replaceMissing` (re-upload = refresh) deactivates notes no longer
 * present, finalised after the last page with the full path list. Pass an
 * explicit `knownPaths` (auto-sync) when the `notes` you send are only the
 * changed/added subset but removal should be scoped to the full scanned set.
 */
export async function ingestKnowledge(
  notes: VaultNote[],
  opts: {
    pin: string;
    replaceMissing?: boolean;
    knownPaths?: string[];
    onProgress?: (done: number, total: number) => void;
  },
): Promise<IngestSummary> {
  const { pin } = opts;
  const { data: userData } = await supabase.auth.getUser();
  const createdBy = userData.user?.id ?? null;

  const pages = pageNotes(notes);
  const total = notes.length;
  const summary = emptySummary();
  let done = 0;

  for (const page of pages) {
    const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
      body: { files: page, createdBy, pin },
    });
    if (error) throw await functionError(error);
    if (data?.error) throw new Error(String(data.error));
    summary.docsAdded += Number(data?.docsAdded ?? 0);
    summary.docsUpdated += Number(data?.docsUpdated ?? 0);
    summary.docsUnchanged += Number(data?.docsUnchanged ?? 0);
    summary.chunks += Number(data?.chunks ?? 0);
    done += page.length;
    opts.onProgress?.(done, total);
  }

  if (opts.replaceMissing) {
    const knownPaths = opts.knownPaths ?? notes.map((n) => n.path);
    const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
      body: {
        files: [],
        replaceMissing: true,
        knownPaths,
        createdBy,
        pin,
      },
    });
    if (error) throw await functionError(error);
    if (data?.error) throw new Error(String(data.error));
    summary.docsRemoved += Number(data?.docsRemoved ?? 0);
  }

  return summary;
}

export interface KnowledgeDoc {
  id: string;
  path: string;
  title: string;
  /** Server-computed content hash — lets auto-sync diff without re-uploading. */
  contentHash: string;
  updatedAt: string;
  chunkCount: number;
}

export interface KnowledgeState {
  /** True when the RAG store (migration / pgvector) isn't applied yet. */
  setupNeeded: boolean;
  docs: KnowledgeDoc[];
  totalChunks: number;
  lastRefreshed: string | null;
}

const SETUP_NEEDED: KnowledgeState = {
  setupNeeded: true,
  docs: [],
  totalChunks: 0,
  lastRefreshed: null,
};

function isMissingRelation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return (
    e?.code === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("could not find the table") ||
    msg.includes("schema cache")
  );
}

/** List active indexed notes with per-note chunk counts. Returns a
 * setup-needed state (not an error) when the migration isn't applied. */
export async function listKnowledgeDocs(): Promise<KnowledgeState> {
  if (!supabaseConfigured) return SETUP_NEEDED;
  try {
    const { data: docs, error: docErr } = await supabase
      .from("knowledge_docs")
      .select("id, path, title, content_hash, updated_at")
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (docErr) throw docErr;

    const { data: chunkRows, error: chunkErr } = await supabase
      .from("knowledge_chunks")
      .select("doc_id")
      .limit(20000);
    if (chunkErr) throw chunkErr;

    const counts = new Map<string, number>();
    for (const row of chunkRows ?? []) {
      const id = String((row as { doc_id: string }).doc_id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const list: KnowledgeDoc[] = (docs ?? []).map((d) => ({
      id: String(d.id),
      path: String(d.path),
      title: String(d.title) || deriveTitle(String(d.path), ""),
      contentHash: String((d as { content_hash?: unknown }).content_hash ?? ""),
      updatedAt: String(d.updated_at),
      chunkCount: counts.get(String(d.id)) ?? 0,
    }));

    return {
      setupNeeded: false,
      docs: list,
      totalChunks: chunkRows?.length ?? 0,
      lastRefreshed: list[0]?.updatedAt ?? null,
    };
  } catch (error) {
    if (isMissingRelation(error)) return SETUP_NEEDED;
    throw error;
  }
}

/**
 * Deactivate one note (hidden from retrieval; chunks kept until re-upload).
 * PIN-gated: routed through the `ingest-knowledge` function so it enforces the
 * owner-set vault PIN + supervisor+ role rather than writing directly.
 */
export async function deactivateKnowledgeDoc(id: string, pin: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
    body: { action: "deactivate", docId: id, pin },
  });
  if (error) throw await functionError(error);
  if (data?.error) throw new Error(String(data.error));
}

/** Clear the whole knowledge base from retrieval (deactivate every note). */
export async function clearKnowledge(pin: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("ingest-knowledge", {
    body: { action: "clear", pin },
  });
  if (error) throw await functionError(error);
  if (data?.error) throw new Error(String(data.error));
}

export interface VaultPinStatus {
  /** False when the migration/RPC isn't applied yet (treat as "no PIN"). */
  available: boolean;
  pinSet: boolean;
}

/**
 * Whether a vault PIN exists — via the boolean-only `vault_pin_is_set` RPC so
 * the hash never reaches the client. Degrades to available:false (owner setup
 * state) when the migration hasn't been applied.
 */
export async function getVaultPinStatus(): Promise<VaultPinStatus> {
  if (!supabaseConfigured) return { available: false, pinSet: false };
  const { data, error } = await supabase.rpc("vault_pin_is_set");
  if (error) {
    if (isMissingRelation(error) || (error as { code?: string }).code === "PGRST202") {
      return { available: false, pinSet: false };
    }
    // Unknown error → don't crash the page; behave as not-yet-configured.
    return { available: false, pinSet: false };
  }
  return { available: true, pinSet: Boolean(data) };
}

/** Owner-only: set or change the shared vault PIN (via the `vault-config` fn). */
export async function setVaultPin(args: {
  newPin: string;
  currentPin?: string;
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke("vault-config", {
    body: { action: "set", newPin: args.newPin, currentPin: args.currentPin ?? "" },
  });
  if (error) throw await functionError(error);
  if (data?.error) throw new Error(String(data.error));
}

/**
 * Live snapshot the offline fallback reads from — the app's TanStack Query cache
 * assembled by the caller (AskInfinity). Every field is optional so a cold cache
 * degrades gracefully: a missing entry just means that class of question isn't
 * answered locally and the caller falls through to the static brain/glossary.
 */
export interface AskLiveData {
  /** The signed-in user's real role — gates data a role shouldn't surface. */
  role?: CrewRole | string | null;
  /** The signed-in user's profile id — scopes "with" names on the schedule. */
  profileId?: string | null;
  /** Local calendar day "YYYY-MM-DD" for schedule/service windows. */
  todayISO: string;
  openings?: ProjectOpening[] | null;
  schedule?: ScheduleAssignment[] | null;
  issues?: Issue[] | null;
  projects?: Array<Pick<Project, "id" | "job_code" | "name">> | null;
  vehicles?: VehicleWithMeta[] | null;
  /** Vehicle links for the user's published schedule (My Schedule's truck line). */
  scheduleVehicles?: ScheduleVehicleLink[] | null;
  /** Trips the user can see (My Schedule's travel line + "my travel" answers). */
  trips?: Trip[] | null;
}

function wantsNextWindow(q: string): boolean {
  return (
    /\bmy next\b/.test(q) ||
    /\bwhat'?s next\b/.test(q) ||
    /\bwhats next\b/.test(q) ||
    /\bnext (window|opening|install|one|job|unit)\b/.test(q)
  );
}

function wantsVehicleService(q: string): boolean {
  const subject = /\b(truck|trucks|vehicle|vehicles|fleet|rig|van|machinery|equipment)\b/.test(q);
  const topic = /\b(service|overdue|maintenance|due|shop|oil|inspection)\b/.test(q);
  return (subject && topic) || /\bvehicle service\b/.test(q);
}

function wantsMyVehicle(q: string): boolean {
  return /\b(my|our)\s+(truck|trucks|vehicle|vehicles|van|rig)\b/.test(q);
}

function wantsMyTravel(q: string): boolean {
  return /\b(travel|trip|trips)\b/.test(q);
}

function wantsIssues(q: string): boolean {
  return /\bissues?\b/.test(q) || /\bblockers?\b/.test(q);
}

function wantsSchedule(q: string): boolean {
  return /\bschedule[d]?\b/.test(q) || /\bthis week\b/.test(q) || /\bmy week\b/.test(q);
}

function opening_line(o: ProjectOpening): string {
  const type = o.window_types?.type_code ?? "type?";
  const job = o.projects?.job_code ?? "job?";
  return `${o.opening_code} — ${type} · ${job} · ${areaKey(o)}`;
}

function answerNextWindow(data: AskLiveData): string | null {
  const openings = data.openings;
  if (!openings) return null;
  const active = openings.filter((o) => o.status !== "installed");
  if (active.length === 0) {
    return "You're all caught up — nothing assigned to you right now.";
  }
  const byId = new Map(active.map((o) => [o.id, o]));
  const ordered = orderMyWork(active.map(toDispatchOpening))
    .map((d) => byId.get(d.id))
    .filter((o): o is ProjectOpening => Boolean(o));
  const inProgress = ordered.find((o) => isInstallInProgress(o));
  const next = inProgress ?? ordered[0];
  if (!next) return null;
  const lines = [
    inProgress ? "You're mid-install:" : "Your next unit:",
    opening_line(next),
  ];
  const remaining = ordered.filter((o) => o.id !== next.id).length;
  if (remaining > 0) {
    lines.push(`${remaining} more in your queue after this.`);
  }
  return lines.join("\n");
}

/** Truck-per-assignment map — the same tie My Schedule renders on each card. */
function vehicleByAssignment(data: AskLiveData): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of data.scheduleVehicles ?? []) {
    if (l.assignment_id && l.vehicle) map.set(l.assignment_id, vehicleTitle(l.vehicle));
  }
  return map;
}

/** Trip-per-project map — the same tie My Schedule renders on each card. */
function tripByProject(data: AskLiveData): Map<string, { id: string; label: string }> {
  const map = new Map<string, { id: string; label: string }>();
  for (const t of data.trips ?? []) {
    if (t.project_id) map.set(t.project_id, { id: t.id, label: t.destination || t.name });
  }
  return map;
}

function answerSchedule(data: AskLiveData): string | null {
  const schedule = data.schedule;
  if (!schedule) return null;
  const weekEnd = addDaysISO(data.todayISO, 6);
  const agenda = buildAgenda(schedule, data.todayISO, weekEnd);
  if (agenda.length === 0) {
    return "Nothing on your published schedule for the next 7 days.";
  }
  const trucks = vehicleByAssignment(data);
  const trips = tripByProject(data);
  const lines: string[] = ["Your schedule this week:"];
  for (const day of agenda) {
    for (const entry of day.entries) {
      const a = entry.assignment;
      const job = a.project?.name ?? a.project?.job_code ?? "Job";
      const bits = [agendaDayLabel(entry.day), job];
      const when = formatStartTime(a.start_time);
      if (when) bits.push(when);
      const mates = data.profileId ? crewmateNames(a, data.profileId) : [];
      const withLine = mates.length > 0 ? ` (with ${mates.join(", ")})` : "";
      lines.push(`• ${bits.join(" · ")}${withLine}`);
      const truck = trucks.get(a.id);
      if (truck) lines.push(`   Truck: ${truck}`);
      const trip = a.project_id ? trips.get(a.project_id) : undefined;
      if (trip) lines.push(`   Travel: ${trip.label}`);
    }
  }
  return lines.join("\n");
}

function answerMyVehicle(question: string, data: AskLiveData): string | null {
  const schedule = data.schedule;
  if (!schedule) return null;
  const today = /\btoday\b/.test(question);
  const from = data.todayISO;
  const to = today ? data.todayISO : addDaysISO(data.todayISO, 6);
  const agenda = buildAgenda(schedule, from, to);
  const trucks = vehicleByAssignment(data);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const day of agenda) {
    for (const entry of day.entries) {
      const a = entry.assignment;
      const truck = trucks.get(a.id);
      if (!truck || seen.has(a.id)) continue;
      seen.add(a.id);
      const job = a.project?.name ?? a.project?.job_code ?? "Job";
      lines.push(`• ${agendaDayLabel(entry.day)} · ${job} — ${truck}`);
    }
  }
  const scope = today ? "today" : "this week";
  if (lines.length === 0) return `No truck is assigned to your schedule ${scope}.`;
  return [`Your truck ${scope}:`, ...lines].join("\n");
}

function answerMyTravel(data: AskLiveData): string | null {
  const trips = data.trips;
  if (!trips) return null;
  const mine = trips
    .filter((t) => t.status === "published")
    .filter((t) => tripPhase(t.start_date, t.end_date, data.todayISO) !== "past")
    .filter((t) => !data.profileId || t.crew.some((c) => c.profile_id === data.profileId))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  if (mine.length === 0) return "No travel on your schedule right now.";
  const lines: string[] = ["Your travel:"];
  for (const t of mine) {
    const label = t.destination || t.name;
    const when =
      t.start_date === t.end_date
        ? agendaDayLabel(t.start_date)
        : `${agendaDayLabel(t.start_date)} – ${agendaDayLabel(t.end_date)}`;
    lines.push(`• ${label} · ${when}`);
  }
  return lines.join("\n");
}

function extractJobToken(q: string): string | null {
  const jobMatch = q.match(/\bjob\s+([a-z0-9][a-z0-9-]*)/);
  if (jobMatch) return jobMatch[1];
  const onMatch = q.match(/\b(?:on|for|at)\s+(.+?)[?.!]*$/);
  if (onMatch) return onMatch[1].trim();
  return null;
}

function answerIssues(q: string, data: AskLiveData): string | null {
  if (!isForemanPlus(data.role)) return null;
  const issues = data.issues;
  if (!issues) return null;
  const projects = data.projects ?? [];
  const token = extractJobToken(q);
  let project: Pick<Project, "id" | "job_code" | "name"> | undefined;
  if (token) {
    project = projects.find(
      (p) =>
        p.job_code.toLowerCase() === token ||
        p.job_code.toLowerCase().includes(token) ||
        p.name.toLowerCase().includes(token),
    );
    if (!project) return null;
  }
  let open = issues.filter((i) => i.status === "open");
  if (project) open = open.filter((i) => i.project_id === project!.id);

  const label = project
    ? `${project.job_code}${project.name ? ` (${project.name})` : ""}`
    : "";
  if (open.length === 0) {
    return project ? `No open issues on ${label}.` : "No open issues right now.";
  }
  const codeById = new Map(projects.map((p) => [p.id, p.job_code]));
  const sorted = [...open].sort(compareIssues).slice(0, 8);
  const header = project ? `Open issues on ${label}:` : `Open issues (${open.length}):`;
  const lines = [header];
  for (const i of sorted) {
    const mark = URGENCY_MARK[i.urgency] ? `${URGENCY_MARK[i.urgency]} ` : "";
    const jobPrefix = project
      ? ""
      : `${(i.project_id ? codeById.get(i.project_id) : null) ?? "New job"} · `;
    const note = i.note ? ` — ${i.note}` : "";
    lines.push(`• ${mark}${jobPrefix}${KIND_LABELS[i.kind]}${note}`);
  }
  if (open.length > sorted.length) {
    lines.push(`…and ${open.length - sorted.length} more.`);
  }
  return lines.join("\n");
}

function answerVehicleService(data: AskLiveData): string | null {
  if (!isSupervisorPlus(data.role)) return null;
  const vehicles = data.vehicles;
  if (!vehicles) return null;
  const flagged = vehicles
    .map((v) => ({
      vehicle: v,
      level: serviceLevel({
        todayISO: data.todayISO,
        nextServiceDate: v.next_service_date,
        odometer: v.odometer,
      }),
      badge: serviceBadge({
        todayISO: data.todayISO,
        nextServiceDate: v.next_service_date,
        odometer: v.odometer,
      }),
    }))
    .filter((r) => r.badge != null);
  if (flagged.length === 0) {
    return "No vehicles are overdue or due for service.";
  }
  const rank = { overdue: 0, due_soon: 1, ok: 2, none: 3 } as const;
  flagged.sort((a, b) => rank[a.level] - rank[b.level]);
  const overdue = flagged.filter((r) => r.level === "overdue").length;
  const lines = [
    overdue > 0
      ? `${overdue} vehicle${overdue > 1 ? "s" : ""} overdue for service:`
      : "Vehicles due for service soon:",
  ];
  for (const r of flagged) {
    const plate = r.vehicle.plate ? ` (${r.vehicle.plate})` : "";
    lines.push(`• ${vehicleTitle(r.vehicle)}${plate} — ${r.badge!.label}`);
  }
  return lines.join("\n");
}

/**
 * Offline grounding: answer a few high-value structured questions straight from
 * the app's live query cache (next window, my schedule, open issues on a job,
 * vehicle service) so the fallback isn't limited to the static brain. Returns
 * null when the question isn't one of these or the backing cache is cold, so
 * the caller can fall through to the bundled brain/glossary/app-guide answer.
 */
export function liveAnswer(question: string, data: AskLiveData): string | null {
  const q = question.toLowerCase().trim();
  if (!q) return null;
  if (wantsNextWindow(q)) return answerNextWindow(data);
  if (wantsVehicleService(q)) return answerVehicleService(data);
  if (wantsMyVehicle(q)) return answerMyVehicle(q, data);
  if (wantsMyTravel(q)) return answerMyTravel(data);
  if (wantsIssues(q)) return answerIssues(q, data);
  if (wantsSchedule(q)) return answerSchedule(data);
  return null;
}

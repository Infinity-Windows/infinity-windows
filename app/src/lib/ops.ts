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
export interface Supply {
  id: string;
  name: string;
  unit: string;
  /** Where it lives — the one spot an installer is told (ticket 07).
   * Optional: rows read before the supplies migration lack the keys. */
  home_location_id?: string | null;
  /** The BOX it lives in — crate, conex or the warehouse — findable the way
   * packages are (owner ask, 2026-08-18). Slots stay parked; this is the
   * rough answer, and the note carries what a box cannot say. */
  home_container_id?: string | null;
  home_note?: string | null;
  /** The running estimate. Null = never counted; the UI says so and never
   * invents a zero. */
  on_hand?: number | null;
  last_counted_at?: string | null;
}
export interface SupplyOrder {
  id: string; project_id: string | null; name: string | null; qty: number; status: string;
  supplies?: { name: string; unit: string } | null;
}
export async function listSupplies(): Promise<Supply[]> {
  const { data, error } = await supabase.from("supplies").select("*").order("name");
  if (error) throw error;
  return (data ?? []) as Supply[];
}

/**
 * Lowest stock first. An uncounted supply (null on_hand) ranks as if it held
 * the AVERAGE of the counted ones: "we don't know" is closer to a problem
 * than "we have plenty," but a known-low shelf still outranks it. Born as the
 * Warehouse overview's preview ranking; lives here so the search drawer and
 * its tests share one definition.
 */
export function lowStockFirst(supplies: Supply[]): Supply[] {
  const known = supplies
    .map((s) => s.on_hand)
    .filter((n): n is number => n != null);
  const unknownRank = known.length
    ? known.reduce((sum, n) => sum + n, 0) / known.length
    : 0;
  return [...supplies].sort(
    (a, b) => (a.on_hand ?? unknownRank) - (b.on_hand ?? unknownRank),
  );
}

/**
 * Name search for the supply drawers: trims, ignores case, matches anywhere
 * in the name, and preserves the caller's order. Empty query = everything,
 * so a list can pipe through it unconditionally.
 */
export function filterSuppliesByName(
  supplies: Supply[],
  query: string,
): Supply[] {
  const q = query.trim().toLowerCase();
  if (!q) return supplies;
  return supplies.filter((s) => s.name.toLowerCase().includes(q));
}

/**
 * "about 140 on hand · last counted Aug 3" — or "not counted yet". The
 * estimate NEVER appears without its date (the ticket's one hard rule): a
 * bare number would read as exact, and this number is deliberately not.
 */
export function onHandLabel(
  s: Pick<Supply, "on_hand" | "last_counted_at">,
): string {
  if (s.on_hand == null || !s.last_counted_at) return "not counted yet";
  const when = new Date(s.last_counted_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `about ${s.on_hand} on hand · last counted ${when}`;
}

/**
 * Take supplies: how many, which job. Decrements the estimate server-side
 * and ticks the oldest matching pull-list row.
 *
 * `clientId` is required, not optional (warehouse audit F1). A phone cannot
 * tell "the server never got it" from "the server got it and the answer never
 * came back", so it retries — and without a key the server would subtract a
 * second time. The caller makes the key ONCE, before the first try, and
 * reuses it on every retry, including the queued one that runs after this
 * call's answer is lost; the server ignores a key it has already applied.
 * See takeSupplyOffline in lib/warehouse/offlineWrites.ts, which is where the
 * key is minted, and migration 20260830000000_take_supply_idempotent.sql.
 */
export async function takeSupply(input: {
  supplyId: string;
  projectId: string;
  qty: number;
  clientId: string;
}): Promise<Supply> {
  const { data, error } = await supabase.rpc("take_supply", {
    p_supply: input.supplyId,
    p_project: input.projectId,
    p_qty: input.qty,
    p_client_id: input.clientId,
  });
  if (error) throw error;
  return data as Supply;
}

/** Counting the shelf corrects the estimate and stamps the date. */
export async function countSupply(supplyId: string, counted: number): Promise<Supply> {
  const { data, error } = await supabase.rpc("count_supply", {
    p_supply: supplyId,
    p_counted: counted,
  });
  if (error) throw error;
  return data as Supply;
}

/**
 * Where a supply lives, in words: "Main Warehouse — north wall, blue bins".
 * The box first, the note after; a dormant slot address still shows for rows
 * set before homes became containers; honest when nothing is set.
 */
export function supplyHomeLabel(
  s: Pick<Supply, "home_container_id" | "home_note" | "home_location_id">,
  containerName: Map<string, string>,
  locationAddress: Map<string, string>,
): string {
  const box = s.home_container_id
    ? (containerName.get(s.home_container_id) ?? "a container")
    : null;
  const slot = s.home_location_id
    ? (locationAddress.get(s.home_location_id) ?? null)
    : null;
  const place = box ?? slot;
  if (!place) return s.home_note ? s.home_note : "no home spot yet";
  return s.home_note ? `${place} — ${s.home_note}` : place;
}

/** Foreman+: set where a supply lives — the box, and the note a box cannot
 * say ("north wall, blue bins"). */
export async function setSupplyHome(input: {
  supplyId: string;
  containerId?: string | null;
  note?: string | null;
}): Promise<Supply> {
  const { data, error } = await supabase.rpc("set_supply_home", {
    p_supply: input.supplyId,
    p_container: input.containerId ?? null,
    p_note: input.note ?? null,
  });
  if (error) throw error;
  return data as Supply;
}
/**
 * Add a supply to the catalog.
 *
 * Goes through an RPC now, not a direct insert: `supplies` used to sit on a
 * blanket "any signed-in user, full access" policy, which made the foreman+
 * gate on home spots decoration — an installer could add a row, change a home
 * spot or fake a count by going around the app. The table is read-only to
 * crew as of the lockdown migration, and this is the one write that was ever
 * made from the client. The server checks the role the UI already checks, and
 * folds a case-insensitive duplicate into the existing row so the catalog
 * cannot fill with "Caulk", "caulk" and "CAULK".
 */
export async function addSupply(name: string, unit: string): Promise<void> {
  const { error } = await supabase.rpc("add_supply", {
    p_name: name,
    p_unit: unit,
  });
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

/** One row of "who took this and where it went" (owner request, ticket 07
 * follow-up: once material leaves the stores he wants a paper trail). */
export interface SupplyTake {
  id: string;
  project_id: string | null;
  qty: number | null;
  /** take_supply writes auth.uid()::text here, not an email like the window
   * movement log does — so it lines up with profiles.id, but there's no
   * declared foreign key from movements.actor (plain text) to profiles.id
   * (uuid) for PostgREST to embed. actor_name is a second lookup by id, the
   * same two-query pattern points.ts already uses for its leaderboard — not
   * a join, because the database has none to invent. */
  actor: string;
  actor_name: string | null;
  created_at: string;
}

/**
 * Every "took" movement for one supply, newest first: who, how many, and
 * which job. Job code isn't resolved here — the Supplies page already loads
 * every project for its own chips, so it looks the code up itself instead of
 * this function re-querying projects it doesn't otherwise need. A name that
 * can't be resolved (bad id, deleted profile) falls back to the raw actor id
 * rather than failing the whole history.
 */
export async function listSupplyTakes(supplyId: string): Promise<SupplyTake[]> {
  const { data, error } = await supabase
    .from("movements")
    .select("id, project_id, qty, actor, created_at")
    .eq("supply_id", supplyId)
    .eq("event", "took")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as Omit<SupplyTake, "actor_name">[];

  const actorIds = [...new Set(rows.map((r) => r.actor).filter(Boolean))];
  const nameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const profiles = await supabase.from("profiles").select("id, display_name").in("id", actorIds);
    if (!profiles.error) {
      for (const p of (profiles.data ?? []) as { id: string; display_name: string }[]) {
        nameById.set(p.id, p.display_name);
      }
    }
  }

  return rows.map((r) => ({ ...r, actor_name: nameById.get(r.actor) ?? null }));
}

// --- QC ---
export interface QcRow {
  id: string; opening_code: string; project_id: string; status: string;
  assigned_window_id: string | null;
  window_types?: { type_code: string } | null;
  qc?: { status: string } | null;
  // Opening codes are unique only WITHIN a job (the DB enforces
  // unique(project_id, opening_code)) and tend to be short — "12-2", "A1" —
  // so two rows from different jobs can carry the exact same code. Carry the
  // job code along so a screen listing openings across jobs can always say
  // which job a code belongs to.
  projects?: { job_code: string } | null;
}
/**
 * Every installed opening, newest-cap-100, alphabetical by code. Kept as-is
 * (unchanged shape and behavior) because four screens share it for a rough
 * "how many installs need eyes" read: Team, Home, and Notifications badges,
 * plus the Issues screen's QC cross-link. The QC review screen itself no
 * longer uses this — see listQcQueue below, which fixes the two problems
 * this shared query has at scale (a still-open opening can fall past the
 * cap and never surface; a decided opening never leaves the list).
 */
export async function listInstalledForQc(): Promise<QcRow[]> {
  const { data, error } = await supabase.from("project_openings")
    .select("id, opening_code, project_id, status, assigned_window_id, window_types(type_code), qc:qc_checks(status), projects(job_code)")
    .eq("status", "installed").order("opening_code").limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as QcRow[];
}

const QC_PAGE_SIZE = 50;

export interface QcQueuePage {
  rows: QcRow[];
  hasMore: boolean;
}

/**
 * The QC review queue (Qc.tsx). Filters server-side to openings that still
 * need a look and orders oldest-installed-first, with paging instead of a
 * hard cap — so a job that has passed 100 lifetime installs can no longer
 * bury an unreviewed window under already-decided ones, and the queue
 * actually drains toward zero instead of silently losing rows.
 *
 * "Still needs a look" means not yet PASSED, not "no row at all" — a
 * callback stays in the queue on purpose. Notifications.tsx's badge already
 * treats a callback as unfinished ("Sign off passes and callbacks"), and
 * Qc.tsx lets a foreman re-decide any row, so a callback has to keep
 * showing up here until it's re-checked and passed.
 */
export async function listQcQueue(
  limit = QC_PAGE_SIZE,
): Promise<QcQueuePage> {
  // setQc only ever writes 'passed' or 'callback' (never 'pending' — see
  // setQc below), so the set of openings that are DONE is just the set with
  // a 'passed' row. Everything else installed is still queue work.
  const passed = await supabase
    .from("qc_checks")
    .select("project_opening_id")
    .eq("status", "passed");
  if (passed.error) throw passed.error;
  const passedIds = (passed.data ?? []).map(
    (r) => (r as { project_opening_id: string }).project_opening_id,
  );

  let query = supabase
    .from("project_openings")
    .select(
      "id, opening_code, project_id, status, assigned_window_id, window_types(type_code), qc:qc_checks(status), projects(job_code)",
      { count: "exact" },
    )
    .eq("status", "installed")
    // work_ended_at is stamped the same moment an opening's status flips to
    // 'installed' (see the install-complete RPC), so this is a genuine
    // oldest-install-first order, not just insertion order.
    .order("work_ended_at", { ascending: true })
    .range(0, limit - 1);
  if (passedIds.length > 0) {
    query = query.not("id", "in", `(${passedIds.join(",")})`);
  }

  const { data, error, count } = await query;
  if (error) throw error;
  const rows = (data ?? []) as unknown as QcRow[];
  // `count` is the total rows matching every filter above (the not-in
  // exclusion included), independent of the range — exactly "how many
  // openings are still queue work", so comparing it to `limit` says
  // whether a bigger page would turn up more.
  const hasMore = count != null ? limit < count : false;
  return { rows, hasMore };
}

/**
 * QC status for a specific set of openings, keyed by opening id. Built for
 * the Issues screen's "QC: callback" cross-link, which only needs the
 * status of the handful of openings its VISIBLE issues actually reference —
 * not the whole installed-openings pool. Issues.tsx currently pulls that
 * whole pool via listInstalledForQc just to look up a few ids; it should
 * swap that call for this one instead.
 */
export async function listQcStatusForOpenings(
  openingIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(openingIds)];
  const byOpening = new Map<string, string>();
  if (ids.length === 0) return byOpening;
  const { data, error } = await supabase
    .from("qc_checks")
    .select("project_opening_id, status")
    .in("project_opening_id", ids);
  if (error) throw error;
  for (const r of (data ?? []) as { project_opening_id: string; status: string }[]) {
    byOpening.set(r.project_opening_id, r.status);
  }
  return byOpening;
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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  embed,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL,
  anthropicChat,
  anthropicToolChat,
  type AnthropicUsage,
} from "../_shared/anthropic.ts";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";
import {
  ASK_SYSTEM_PROMPT,
  buildAnthropicMessages,
  buildAskUserMessage,
  buildContextBlock,
  dedupeSources,
  shapeMatches,
  type LiveContext,
} from "../_shared/knowledge.ts";
import {
  appGuideForRole,
  guideRank,
  issuesScopeForRole,
  renderAppGuide,
} from "../_shared/appGuide.ts";
import { estimateJob, recommendCrew, type EstimateOpening, type TypeStat } from "../_shared/estimate.ts";
import {
  parseDateRangeInput,
  parseDraftEntriesInput,
  SCHEDULING_SYSTEM_PROMPT,
  SCHEDULING_TOOLS,
  schedulingRefusal,
  type DraftEntry,
} from "../_shared/schedulingTools.ts";

// Wave A2: SCHEDULING_TOOLS is offered on EVERY ask call, to every caller — a
// below-rank caller gets the same clean tool refusal a human trying a hidden
// button would get, rather than the tools quietly not existing for them
// (PERMISSION MIRROR).
const SYSTEM_PROMPT = ASK_SYSTEM_PROMPT + SCHEDULING_SYSTEM_PROMPT;

/** Plain progress lines for the doors (A4): what the Ask page shows while the
 * model works, built from the tool calls it actually made. */
function toolActivityLine(name: string, input: unknown): string {
  switch (name) {
    case "get_scheduling_picture":
      return "Reading the week…";
    case "draft_assignments": {
      const n = Array.isArray((input as { entries?: unknown })?.entries)
        ? ((input as { entries: unknown[] }).entries.length)
        : 0;
      return `Drafting ${n} assignment${n === 1 ? "" : "s"}…`;
    }
    case "clear_ai_drafts":
      return "Clearing earlier AI drafts…";
    default:
      return "Working…";
  }
}

interface HistoryTurn {
  role: string;
  content: string;
}

/** Wave D: every job currently in the trash, service-role read (this whole
 * file runs on the service-role key, which bypasses the RLS predicate that
 * hides a trashed job's row everywhere else — so it has to be checked by
 * hand here, same reasoning as the `.is("removed_at", null)` calls below).
 * One query, reused across loadMyProjectIds and loadLiveContext rather than
 * re-fetched per caller. Best-effort — degrades to "nothing is trashed"
 * rather than breaking the answer. */
async function loadTrashedProjectIds(
  supabase: ReturnType<typeof createClient>,
): Promise<Set<string>> {
  try {
    const { data } = await supabase.from("projects").select("id").not("deleted_at", "is", null);
    return new Set((data ?? []).map((r) => r.id as string));
  } catch (_e) {
    return new Set<string>();
  }
}

/** The set of project ids the asking user is on: the crews they're scheduled on
 * plus any openings assigned to them. Mirrors the `can_access_project_chat`
 * membership test and is reused to scope BOTH an installer's issues and their
 * job chat to jobs they can actually reach. Best-effort — degrades to empty. */
async function loadMyProjectIds(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  trashedIds: Set<string>,
): Promise<Set<string>> {
  const projectIds = new Set<string>();
  try {
    const { data: memberRows } = await supabase
      .from("schedule_assignment_members")
      .select("schedule_assignments(project_id)")
      .eq("profile_id", userId);
    for (const m of memberRows ?? []) {
      const a = m.schedule_assignments as { project_id?: string } | null;
      if (a?.project_id) projectIds.add(a.project_id);
    }
  } catch (_e) {
    // no-op: schedule membership unavailable
  }
  try {
    // `.is("removed_at", null)` by hand here and below: this function holds the
    // service-role key, which bypasses the row level security that hides
    // removed openings from everything else. These two are the only reads of
    // this table in any edge function.
    const { data: openingRows } = await supabase
      .from("project_openings")
      .select("project_id")
      .eq("assigned_to", userId)
      .is("removed_at", null);
    for (const o of openingRows ?? []) {
      if (o.project_id) projectIds.add(o.project_id as string);
    }
  } catch (_e) {
    // no-op: assigned openings unavailable
  }
  // Wave D: strip out anything currently trashed — a deleted job's crew
  // membership must never re-open its issues/chat to an installer just
  // because RLS can't be relied on in this service-role function.
  for (const id of trashedIds) projectIds.delete(id);
  return projectIds;
}

/** Best-effort compact snapshot of live app data for grounding. Every query
 * degrades to empty so a missing table/column never breaks the answer. */
async function loadLiveContext(
  supabase: ReturnType<typeof createClient>,
  userId: string | null,
): Promise<LiveContext> {
  const live: LiveContext = {};
  const today = new Date().toISOString().slice(0, 10);
  // Wave D: fetched once, reused everywhere below a trashed job could
  // otherwise leak through this service-role function.
  const trashedIds = await loadTrashedProjectIds(supabase);

  // The asking user's role is the single gate for everything below. Fetched on
  // the service-role key (which bypasses RLS), so role-based access control MUST
  // be enforced here in code — nothing else stops the AI leaking restricted data.
  // Unknown/missing role degrades to installer (rank 0), never over-exposes.
  let role: string | null = null;
  if (userId) {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .maybeSingle();
      role = (data?.role as string | undefined) ?? null;
    } catch (_e) {
      // no-op: role unavailable → treated as installer floor below.
    }
  }
  const rank = guideRank(role);
  const isForemanPlus = rank >= 1;
  const isManagement = rank >= 2; // supervisor+ — the financials/sensitive gate.
  if (role) live.role = role;

  // (A) Role-aware app guide: only the tabs this user's role can reach.
  try {
    const guide = renderAppGuide(appGuideForRole(role));
    if (guide) live.appGuide = guide;
  } catch (_e) {
    // no-op: app guide unavailable
  }

  try {
    const { data } = await supabase
      .from("projects")
      .select("name, job_code, status")
      .eq("status", "active")
      .is("deleted_at", null)
      .order("name")
      .limit(25);
    if (data) live.projects = data as LiveContext["projects"];
  } catch (_e) {
    // no-op: projects unavailable
  }

  try {
    const { data } = await supabase
      .from("window_types")
      .select("type_code, name, n_installs")
      .eq("provisional", false)
      .order("n_installs", { ascending: false })
      .limit(20);
    if (data) live.windowTypes = data as LiveContext["windowTypes"];
  } catch (_e) {
    // no-op: catalog unavailable
  }

  if (userId) {
    try {
      const { data: members } = await supabase
        .from("schedule_assignment_members")
        .select("assignment_id")
        .eq("profile_id", userId);
      const ids = (members ?? []).map((m) => m.assignment_id).filter(Boolean);
      if (ids.length > 0) {
        const { data: assignments } = await supabase
          .from("schedule_assignments")
          .select("project_id, start_date, end_date, start_time, status, projects(name, job_code)")
          .in("id", ids)
          .eq("status", "published")
          .gte("end_date", today)
          .order("start_date")
          .limit(15);
        // Wave D: a deleted job's schedule row survives untouched for the
        // whole 30-day trash window (trash never rewrites project_id) —
        // filter it out here by hand, same reasoning as trashedIds above.
        live.schedule = (assignments ?? [])
          .filter((a) => !a.project_id || !trashedIds.has(a.project_id as string))
          .map((a) => {
            const proj = a.projects as { name?: string; job_code?: string } | null;
            return {
              project:
                [proj?.job_code, proj?.name].filter(Boolean).join(" ").trim() || "job",
              start_date: a.start_date as string,
              end_date: a.end_date as string,
              start_time: (a.start_time as string | null) ?? null,
            };
          });
      }
    } catch (_e) {
      // no-op: schedule unavailable
    }
  }

  // (B) The asking user's OWN complete, install-ordered list of assigned
  // windows/doors + where each unit is (all roles). Joins opening → assigned
  // unit → warehouse location so the AI can answer "what am I installing and in
  // what order, and where are the units?". `sequence` is the dispatch/walk order
  // set by the lead (crew_dispatch: `set_openings_sequence`); order by it with
  // `opening_code` as a stable tiebreaker so unsequenced openings still sort
  // deterministically. Apply `.eq` on the filter builder BEFORE `.order`/`.limit`.
  // Strictly scoped to assigned_to = the asking user — never broadened.
  if (userId) {
    try {
      const { data } = await supabase
        .from("project_openings")
        .select(
          "project_id, opening_code, label, status, window_types(category), windows(window_id, status, locations(address)), projects(name, job_code)",
        )
        .eq("assigned_to", userId)
        .is("removed_at", null)
        .order("sequence", { nullsFirst: false })
        .order("opening_code", { nullsFirst: false })
        .limit(50);
      // Wave D: same trashed-job filter as (A) above — an installer's "what
      // am I installing" list must not keep naming a job that was deleted.
      const liveData = (data ?? []).filter(
        (o) => !o.project_id || !trashedIds.has(o.project_id as string),
      );
      if (liveData.length > 0) {
        live.assignments = liveData.map((o) => {
          const wt = o.window_types as { category?: string } | null;
          const unit = o.windows as
            | { window_id?: string; status?: string; locations?: { address?: string } | null }
            | null;
          const proj = o.projects as { name?: string; job_code?: string } | null;
          const code = (o.opening_code as string | null) ?? "";
          const isDoor =
            (wt?.category ?? "").toLowerCase().includes("door") || /^D\d/i.test(code);
          const addr = unit?.locations?.address ?? null;
          const unitStatus = unit?.status ?? null;
          const location =
            addr ??
            (unitStatus === "loaded"
              ? "on the truck"
              : unitStatus === "installed"
                ? "installed"
                : unitStatus === "damaged"
                  ? "damaged / hold"
                  : null);
          return {
            kind: (isDoor ? "door" : "window") as "window" | "door",
            code,
            label: (o.label as string | null) ?? null,
            status: (o.status as string | null) ?? undefined,
            job:
              [proj?.job_code, proj?.name].filter(Boolean).join(" ").trim() || "job",
            unit: unit?.window_id ?? null,
            location,
          };
        });
      }
    } catch (_e) {
      // no-op: assignments unavailable
    }
  }

  // Project-id set the asking user is on — computed once and reused to scope an
  // installer's issues and their job chat (mirrors can_access_project_chat).
  const myProjects = userId
    ? await loadMyProjectIds(supabase, userId, trashedIds)
    : new Set<string>();

  // Open issues. In-app the Issues feature is foreman+ (list_issues/assign_issue
  // are guarded to foreman-and-above), so:
  //   - foreman+ get the company-wide open list (top 20), matching the tab.
  //   - an installer NEVER gets company-wide issues; they only see issues on the
  //     jobs THEY are on, so "any issues on my job?" works without leaking other
  //     crews'/company issues. On no jobs, the block is simply empty.
  try {
    const scope = issuesScopeForRole(role, myProjects.size);
    if (scope !== "none") {
      // Apply the installer project-scope filter BEFORE order/limit (filter
      // methods live on the filter builder). Foreman+ ("company") skip it.
      let filter = supabase
        .from("issues")
        .select("project_id, kind, urgency, note, created_at, projects(name, job_code)")
        .eq("status", "open");
      if (scope === "own-jobs") {
        // myProjects is already trashed-filtered (loadMyProjectIds).
        filter = filter.in("project_id", [...myProjects]);
      }
      const { data: rawIssues } = await filter
        .order("created_at", { ascending: false })
        .limit(20);
      // Wave D: the company-wide branch has no per-project filter at all, so
      // it needs its own trashedIds check — the own-jobs branch above is
      // already covered via myProjects.
      const data = (rawIssues ?? []).filter(
        (i) => !i.project_id || !trashedIds.has(i.project_id as string),
      );
      if (data.length > 0) {
        live.issues = data.map((r) => {
          const proj = r.projects as { name?: string; job_code?: string } | null;
          const created = r.created_at ? new Date(r.created_at as string) : null;
          const ageDays =
            created && !Number.isNaN(created.getTime())
              ? Math.max(0, Math.floor((Date.now() - created.getTime()) / 86_400_000))
              : undefined;
          return {
            job: [proj?.job_code, proj?.name].filter(Boolean).join(" ").trim() || "job",
            kind: (r.kind as string) ?? "issue",
            urgency: (r.urgency as string) ?? "normal",
            note: (r.note as string | null) ?? null,
            ageDays,
          };
        });
      }
    }
  } catch (_e) {
    // no-op: issues unavailable
  }

  // Inventory (company-wide): cheap aggregate buckets + top on-hand types +
  // outstanding supplies. Prefer counts/aggregates over dumping every unit.
  try {
    const inventory: NonNullable<LiveContext["inventory"]> = {};
    const headCount = () =>
      supabase.from("windows").select("id", { count: "exact", head: true });
    const [onHand, staged, damaged, inbound] = await Promise.all([
      headCount().not("status", "in", "(installed,loaded)"),
      headCount().eq("status", "staged"),
      headCount().eq("status", "damaged"),
      headCount().eq("status", "inbound"),
    ]);
    if (typeof onHand.count === "number") inventory.onHand = onHand.count;
    if (typeof staged.count === "number") inventory.staged = staged.count;
    if (typeof damaged.count === "number") inventory.damaged = damaged.count;
    if (typeof inbound.count === "number") inventory.inbound = inbound.count;

    // One bounded projection (indexed on status) rolled up three ways client-side:
    // top on-hand types, stock by warehouse slot (where units live), and units
    // staged per job. All roles may see where units are — the task keeps field
    // roles able to locate units; we keep it compact via caps.
    try {
      const { data } = await supabase
        .from("windows")
        .select(
          "status, window_types(type_code, name), locations(address, zone), projects(job_code, name)",
        )
        .in("status", ["in_warehouse", "staged"])
        .limit(3000);
      if (data && data.length > 0) {
        const typeCounts = new Map<
          string,
          { type_code?: string; name?: string; count: number }
        >();
        const locCounts = new Map<string, { address?: string; zone?: string; count: number }>();
        const jobCounts = new Map<string, { job?: string; count: number }>();
        for (const row of data) {
          const wt = row.window_types as { type_code?: string; name?: string } | null;
          const tKey = (wt?.type_code ?? wt?.name ?? "").trim();
          if (tKey) {
            const cur = typeCounts.get(tKey);
            if (cur) cur.count += 1;
            else typeCounts.set(tKey, { type_code: wt?.type_code, name: wt?.name, count: 1 });
          }

          const loc = row.locations as { address?: string; zone?: string } | null;
          const lKey = (loc?.address ?? "").trim();
          if (lKey) {
            const cur = locCounts.get(lKey);
            if (cur) cur.count += 1;
            else locCounts.set(lKey, { address: loc?.address, zone: loc?.zone, count: 1 });
          }

          if (row.status === "staged") {
            const proj = row.projects as { job_code?: string; name?: string } | null;
            const jKey =
              [proj?.job_code, proj?.name].filter(Boolean).join(" ").trim();
            if (jKey) {
              const cur = jobCounts.get(jKey);
              if (cur) cur.count += 1;
              else jobCounts.set(jKey, { job: jKey, count: 1 });
            }
          }
        }
        if (typeCounts.size > 0) {
          inventory.topOnHand = [...typeCounts.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 15);
        }
        if (locCounts.size > 0) {
          inventory.byLocation = [...locCounts.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 15);
        }
        if (jobCounts.size > 0) {
          inventory.stagedForJobs = [...jobCounts.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        }
      }
    } catch (_e) {
      // no-op: per-type/location rollup unavailable
    }

    // Outstanding supply orders (needed/ordered), most recent first.
    try {
      const { data } = await supabase
        .from("supply_orders")
        .select("name, qty, status, supplies(name)")
        .in("status", ["needed", "ordered"])
        .order("created_at", { ascending: false })
        .limit(15);
      if (data && data.length > 0) {
        inventory.supplies = data.map((r) => {
          const s = r.supplies as { name?: string } | null;
          return {
            name: ((r.name as string | null) ?? s?.name ?? "supply").trim() || "supply",
            qty: typeof r.qty === "number" ? (r.qty as number) : Number(r.qty ?? 0) || undefined,
            status: (r.status as string) ?? undefined,
          };
        });
      }
    } catch (_e) {
      // no-op: supplies unavailable
    }

    if (Object.keys(inventory).length > 0) live.inventory = inventory;
  } catch (_e) {
    // no-op: inventory unavailable
  }

  // (Scheduled work) Foreman+ also see the crew/job schedule (who's scheduled
  // where). Installers already get their own schedule above; this adds the
  // coordination view for managers only.
  if (isForemanPlus) {
    try {
      const { data } = await supabase
        .from("schedule_assignments")
        .select(
          "start_date, end_date, start_time, projects(name, job_code), schedule_assignment_members(profiles(display_name))",
        )
        .eq("status", "published")
        .gte("end_date", today)
        .order("start_date")
        .limit(20);
      if (data && data.length > 0) {
        live.crewSchedule = data.map((a) => {
          const proj = a.projects as { name?: string; job_code?: string } | null;
          const members = (a.schedule_assignment_members ?? []) as Array<{
            profiles?: { display_name?: string } | null;
          }>;
          const crew = members
            .map((m) => m.profiles?.display_name)
            .filter((n): n is string => Boolean(n));
          return {
            job:
              [proj?.job_code, proj?.name].filter(Boolean).join(" ").trim() || "job",
            start_date: a.start_date as string,
            end_date: a.end_date as string,
            start_time: (a.start_time as string | null) ?? null,
            crew,
          };
        });
      }
    } catch (_e) {
      // no-op: crew schedule unavailable
    }
  }

  // (Financials / sensitive) MANAGEMENT-ONLY (supervisor+). Bids, costs and
  // margins are NEVER fetched for installer/foreman — the block simply doesn't
  // run for them, so the model can't be given data it must not reveal.
  if (isManagement) {
    try {
      const { data: projs } = await supabase
        .from("projects")
        .select("id, name, job_code, bid_amount, target_margin_pct")
        .eq("status", "active")
        .is("deleted_at", null)
        .not("bid_amount", "is", null)
        .order("bid_amount", { ascending: false })
        .limit(15);
      const rows = (projs ?? []) as Array<{
        id: string;
        name?: string;
        job_code?: string;
        bid_amount?: number | null;
        target_margin_pct?: number | null;
      }>;
      if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        const costsByProject = new Map<string, number>();
        try {
          const { data: costs } = await supabase
            .from("job_costs")
            .select("project_id, amount")
            .in("project_id", ids)
            .limit(3000);
          for (const c of (costs ?? []) as Array<{ project_id?: string; amount?: number }>) {
            if (!c.project_id) continue;
            costsByProject.set(
              c.project_id,
              (costsByProject.get(c.project_id) ?? 0) + (Number(c.amount) || 0),
            );
          }
        } catch (_e) {
          // no-op: cost ledger unavailable → margins degrade to bid-only.
        }
        const changeByProject = new Map<string, number>();
        try {
          const { data: cos } = await supabase
            .from("change_orders")
            .select("project_id, amount")
            .in("project_id", ids)
            .limit(2000);
          for (const c of (cos ?? []) as Array<{ project_id?: string; amount?: number }>) {
            if (!c.project_id) continue;
            changeByProject.set(
              c.project_id,
              (changeByProject.get(c.project_id) ?? 0) + (Number(c.amount) || 0),
            );
          }
        } catch (_e) {
          // no-op: change orders unavailable
        }

        let totalBid = 0;
        let totalCosts = 0;
        const jobs = rows.map((r) => {
          const bid = Number(r.bid_amount) || 0;
          const revenue = bid + (changeByProject.get(r.id) ?? 0);
          const costs = costsByProject.get(r.id) ?? 0;
          totalBid += revenue;
          totalCosts += costs;
          const marginPct =
            revenue > 0 ? ((revenue - costs) / revenue) * 100 : undefined;
          return {
            job: [r.job_code, r.name].filter(Boolean).join(" ").trim() || "job",
            bid: revenue,
            costs,
            marginPct,
            targetMarginPct:
              typeof r.target_margin_pct === "number" ? r.target_margin_pct : undefined,
          };
        });
        live.financials = { jobs, totalBid, totalCosts };
      }
    } catch (_e) {
      // no-op: financials unavailable
    }
  }

  // Recent job chat, scoped to jobs the ASKING USER is on (never leak other
  // crews' threads). Mirrors can_access_project_chat: schedule crew + assigned
  // openings decide which projects' messages this user may see. Reuses the same
  // project-id set computed above for the installer issues scope.
  if (userId) {
    try {
      const projectIds = myProjects;
      if (projectIds.size > 0) {
        const { data } = await supabase
          .from("project_messages")
          .select("body, created_at, profiles(display_name), projects(name, job_code)")
          .in("project_id", [...projectIds])
          .order("created_at", { ascending: false })
          .limit(15);
        if (data) {
          live.chat = data.map((m) => {
            const proj = m.projects as { name?: string; job_code?: string } | null;
            const author = m.profiles as { display_name?: string } | null;
            return {
              job: [proj?.job_code, proj?.name].filter(Boolean).join(" ").trim() || "job",
              sender: author?.display_name ?? "someone",
              body: (m.body as string) ?? "",
              when: (m.created_at as string | null) ?? undefined,
            };
          });
        }
      }
    } catch (_e) {
      // no-op: chat unavailable
    }
  }

  return live;
}

// ---------------------------------------------------------------------------
// Wave A2: the scheduling toolset. Tool DEFINITIONS, the permission gate, and
// pure input validation live in _shared/schedulingTools.ts (unit-tested).
// What's here is the impure half — the actual queries and writes — kept in
// this file for the same reason loadLiveContext above is: it needs a live
// Supabase client, so it can't be pure-extracted, same split this file
// already draws.
//
// Every query below runs on a client scoped to the CALLER's own JWT
// (callerSupabaseClient), never the service-role key: RLS on
// schedule_assignments/project_openings/projects/profiles/capability_badges
// is "authenticated full access" (the trusted-crew pattern those tables all
// share), so the my_role_rank() >= 2 check inside schedulingRefusal — run
// against THIS caller's own auth.uid() — is the only thing actually gating
// who can read or write through these tools. PERMISSION MIRROR: the AI holds
// exactly the caller's own power, never more.
// ---------------------------------------------------------------------------

type SupabaseLike = ReturnType<typeof createClient>;

/** The caller's own role_rank() (owner 3 / supervisor 2 / foreman 1 /
 * installer 0), queried on the caller-scoped client so `auth.uid()` resolves
 * to them. Degrades to 0 (installer floor) on any failure — never over-grant. */
async function callerRank(client: SupabaseLike): Promise<number> {
  try {
    const { data, error } = await client.rpc("my_role_rank");
    if (error || typeof data !== "number") return 0;
    return data;
  } catch (_e) {
    return 0;
  }
}

/** The board's own "foreman or installer" split for a schedule_assignment
 * member (mirrors Scheduling.tsx's roleOf()) — a board role, not the
 * organizational role_rank ladder. */
function crewMemberRole(profileRole: string | null | undefined): "foreman" | "installer" {
  switch (profileRole) {
    case "foreman":
    case "lead":
    case "supervisor":
    case "admin":
    case "owner":
    case "big_boss":
      return "foreman";
    default:
      return "installer";
  }
}

/** blue=window, green=door — mirrors loadLiveContext's own isDoor check
 * above, kept as its own small copy rather than a shared extraction so this
 * block stays self-contained (see the header note on scope). */
function isDoorOpening(category: string | null | undefined, code: string | null | undefined): boolean {
  return (category ?? "").toLowerCase().includes("door") || /^D\d/i.test(code ?? "");
}

interface OpeningForEstimate {
  opening_code: string | null;
  status: string | null;
  window_type_id: string | null;
  window_types: {
    category?: string | null;
    median_minutes?: number | null;
    p90_minutes?: number | null;
    difficulty_rating?: number | null;
    learned_difficulty?: number | null;
  } | null;
}

/**
 * get_scheduling_picture's read: active jobs (remaining units by kind + the
 * app's OWN day/crew estimate via lib/estimate.ts's estimateJob/
 * recommendCrew — "the math the AI must surface, not reinvent"), the crew
 * roster with capabilities/booked dates, saved crews, and this assistant's
 * own existing drafts in range. Every block degrades to empty on its own
 * failure, same style as loadLiveContext.
 */
async function buildSchedulingPicture(
  client: SupabaseLike,
  from: string,
  to: string,
): Promise<Record<string, unknown>> {
  const picture: Record<string, unknown> = { range: { from, to } };

  // -- Active jobs: remaining window/door counts + the app's own estimate.
  try {
    const { data: projectRows } = await client
      .from("projects")
      .select("id, job_code, name, address")
      .eq("status", "active")
      .is("deleted_at", null)
      .order("job_code")
      .limit(40);
    const projects = (projectRows ?? []) as Array<{
      id: string;
      job_code: string;
      name: string;
      address: string | null;
    }>;
    const projectIds = projects.map((p) => p.id);

    const openingsByProject = new Map<string, OpeningForEstimate[]>();
    if (projectIds.length > 0) {
      const { data: openingRows } = await client
        .from("project_openings")
        .select(
          "project_id, opening_code, status, window_type_id, window_types(category, median_minutes, p90_minutes, difficulty_rating, learned_difficulty)",
        )
        .in("project_id", projectIds)
        .is("removed_at", null)
        .limit(5000);
      for (const row of (openingRows ?? []) as Array<OpeningForEstimate & { project_id: string }>) {
        const list = openingsByProject.get(row.project_id) ?? [];
        list.push(row);
        openingsByProject.set(row.project_id, list);
      }
    }

    picture.active_jobs = projects.map((p) => {
      const openings = openingsByProject.get(p.id) ?? [];
      let windowCount = 0;
      let doorCount = 0;
      const statsByType = new Map<string, TypeStat>();
      const estimateOpenings: EstimateOpening[] = [];
      for (const o of openings) {
        const installed = o.status === "installed";
        if (!installed) {
          if (isDoorOpening(o.window_types?.category, o.opening_code)) doorCount++;
          else windowCount++;
        }
        estimateOpenings.push({ window_type_id: o.window_type_id, installed });
        if (o.window_type_id && !statsByType.has(o.window_type_id)) {
          statsByType.set(o.window_type_id, {
            window_type_id: o.window_type_id,
            median_minutes: o.window_types?.median_minutes ?? null,
            p90_minutes: o.window_types?.p90_minutes ?? null,
            difficulty: o.window_types?.learned_difficulty ?? o.window_types?.difficulty_rating ?? null,
          });
        }
      }
      const est = estimateJob(estimateOpenings, [...statsByType.values()]);
      const crew = recommendCrew(est);
      return {
        id: p.id,
        code: p.job_code,
        name: p.name,
        address: p.address,
        remaining: { window: windowCount, door: doorCount },
        estimate: {
          remaining_openings: est.remaining,
          expected_minutes: est.expectedMinutes,
          p90_minutes: est.p90Minutes,
          unknown_types: est.unknownTypes,
          recommended_crew: crew.recommendedCrew,
          crew_hours: crew.crewHours,
          hours_to_finish: crew.hoursToFinish,
        },
      };
    });
  } catch (_e) {
    picture.active_jobs = [];
  }

  // -- Crew roster: skill/role/active + capabilities + who's already booked.
  try {
    const { data: profileRows } = await client
      .from("profiles")
      .select("id, display_name, skill_level, role, active")
      .order("display_name")
      .limit(300);
    const profiles = (profileRows ?? []) as Array<{
      id: string;
      display_name: string;
      skill_level: number;
      role: string;
      active: boolean;
    }>;

    const capsByProfile = new Map<string, string[]>();
    try {
      const { data: badgeRows } = await client
        .from("capability_badges")
        .select("installer_id, capability")
        .limit(2000);
      for (const b of (badgeRows ?? []) as Array<{ installer_id: string; capability: string }>) {
        const list = capsByProfile.get(b.installer_id) ?? [];
        list.push(b.capability);
        capsByProfile.set(b.installer_id, list);
      }
    } catch (_e) {
      // no-op: capabilities unavailable
    }

    // Any non-canceled assignment overlapping the range counts as "booked" —
    // draft or published alike, matching lib/schedule/conflicts.ts's own
    // "everything currently in play" philosophy for double-booking.
    const bookedByProfile = new Map<
      string,
      Array<{ job: string | null; start_date: string; end_date: string; status: string }>
    >();
    try {
      const { data: assignmentRows } = await client
        .from("schedule_assignments")
        .select("id, start_date, end_date, status, projects(job_code), schedule_assignment_members(profile_id)")
        .lte("start_date", to)
        .gte("end_date", from)
        .neq("status", "canceled")
        .limit(2000);
      for (const a of (assignmentRows ?? []) as Array<{
        start_date: string;
        end_date: string;
        status: string;
        projects: { job_code?: string } | null;
        schedule_assignment_members: Array<{ profile_id: string }> | null;
      }>) {
        for (const m of a.schedule_assignment_members ?? []) {
          const list = bookedByProfile.get(m.profile_id) ?? [];
          list.push({
            job: a.projects?.job_code ?? null,
            start_date: a.start_date,
            end_date: a.end_date,
            status: a.status,
          });
          bookedByProfile.set(m.profile_id, list);
        }
      }
    } catch (_e) {
      // no-op: booked dates unavailable — the model reasons without them
    }

    picture.crew = profiles.map((p) => ({
      id: p.id,
      name: p.display_name,
      skill_level: p.skill_level,
      role: p.role,
      active: p.active,
      capabilities: capsByProfile.get(p.id) ?? [],
      booked: bookedByProfile.get(p.id) ?? [],
    }));
  } catch (_e) {
    picture.crew = [];
  }

  // -- Saved crews (wave A1): the AI's soft law is to keep these together.
  try {
    const { data } = await client
      .from("saved_crews")
      .select("id, name, member_ids, note")
      .order("name")
      .limit(100);
    picture.saved_crews = data ?? [];
  } catch (_e) {
    picture.saved_crews = [];
  }

  // -- This assistant's own existing drafts in range (wave A3's created_via
  // marker) — so a follow-up turn can see what it already proposed.
  try {
    const { data } = await client
      .from("schedule_assignments")
      .select("id, start_date, end_date, projects(job_code), schedule_assignment_members(profile_id)")
      .eq("status", "draft")
      .eq("created_via", "ai")
      .lte("start_date", to)
      .gte("end_date", from)
      .limit(300);
    picture.existing_ai_drafts = ((data ?? []) as Array<{
      id: string;
      start_date: string;
      end_date: string;
      projects: { job_code?: string } | null;
      schedule_assignment_members: Array<{ profile_id: string }> | null;
    }>).map((a) => ({
      id: a.id,
      job: a.projects?.job_code ?? null,
      start_date: a.start_date,
      end_date: a.end_date,
      profile_ids: (a.schedule_assignment_members ?? []).map((m) => m.profile_id),
    }));
  } catch (_e) {
    picture.existing_ai_drafts = [];
  }

  return picture;
}

/** One {start,end,project_id} span a profile is already committed to, from
 * either the database or earlier in the SAME draft_assignments call. */
interface BookedSpan {
  start: string;
  end: string;
  project_id: string;
}

/**
 * draft_assignments' write: one schedule_assignments row per entry — the
 * board's own single-day/single-member draft unit (Scheduling.tsx's own
 * createDayDraft makes the identical shape) — tagged created_via='ai'.
 * Never publishes: status is always 'draft'.
 */
async function executeDraftAssignments(
  client: SupabaseLike,
  callerUid: string,
  rawInput: unknown,
): Promise<{ content: string; is_error?: boolean }> {
  const parsed = parseDraftEntriesInput(rawInput);
  if (parsed.formatError) return { content: parsed.formatError, is_error: true };

  const results: Array<Record<string, unknown>> = parsed.errors.map((e) => ({
    index: e.index,
    ok: false,
    reason: "invalid_entry",
    detail: e.reason,
  }));

  if (parsed.entries.length === 0) {
    return { content: JSON.stringify({ results, drafted: 0, refused: results.length }) };
  }

  const projectIds = [...new Set(parsed.entries.map((e: DraftEntry) => e.project_id))];
  const profileIds = [...new Set(parsed.entries.map((e: DraftEntry) => e.profile_id))];

  // Wave D: an owner can still see their own trashed job's row (RLS lets
  // them), so this is an explicit belt-and-suspenders check, not just RLS —
  // PERMISSION MIRROR means the AI can't schedule against a job the owner's
  // own UI no longer offers to schedule against either.
  const { data: projectRows } = await client
    .from("projects")
    .select("id")
    .in("id", projectIds)
    .is("deleted_at", null);
  const knownProjects = new Set(((projectRows ?? []) as Array<{ id: string }>).map((p) => p.id));

  const { data: profileRows } = await client
    .from("profiles")
    .select("id, role, active")
    .in("id", profileIds);
  const profileById = new Map(
    ((profileRows ?? []) as Array<{ id: string; role: string; active: boolean }>).map((p) => [p.id, p]),
  );

  // Every non-canceled assignment that could touch this batch's dates.
  const dates = parsed.entries.map((e) => e.date).sort();
  const { data: existingRows } = await client
    .from("schedule_assignments")
    .select("id, project_id, start_date, end_date, schedule_assignment_members(profile_id)")
    .lte("start_date", dates[dates.length - 1])
    .gte("end_date", dates[0])
    .neq("status", "canceled")
    .limit(2000);
  const bookedByProfile = new Map<string, BookedSpan[]>();
  for (const a of (existingRows ?? []) as Array<{
    project_id: string | null;
    start_date: string;
    end_date: string;
    schedule_assignment_members: Array<{ profile_id: string }> | null;
  }>) {
    if (!a.project_id) continue;
    for (const m of a.schedule_assignment_members ?? []) {
      const list = bookedByProfile.get(m.profile_id) ?? [];
      list.push({ start: a.start_date, end: a.end_date, project_id: a.project_id });
      bookedByProfile.set(m.profile_id, list);
    }
  }
  // Claims made earlier IN THIS SAME CALL — a batch must not double-book
  // itself either.
  const claimedThisCall = new Map<string, BookedSpan[]>();

  let drafted = 0;
  for (const entry of parsed.entries) {
    if (!knownProjects.has(entry.project_id)) {
      results.push({ ...entry, ok: false, reason: "unknown_project" });
      continue;
    }
    const profile = profileById.get(entry.profile_id);
    if (!profile || !profile.active) {
      results.push({ ...entry, ok: false, reason: "unknown_profile" });
      continue;
    }

    const spans = [...(bookedByProfile.get(entry.profile_id) ?? []), ...(claimedThisCall.get(entry.profile_id) ?? [])];
    const covering = spans.find((s) => entry.date >= s.start && entry.date <= s.end);
    if (covering && covering.project_id !== entry.project_id) {
      results.push({ ...entry, ok: false, reason: "double_booked" });
      continue;
    }
    if (covering) {
      // Already scheduled on this exact job/day — idempotent, not a second
      // stacked chip.
      results.push({ ...entry, ok: true, note: "already scheduled" });
      drafted++;
      continue;
    }

    const { data: created, error: insertError } = await client
      .from("schedule_assignments")
      .insert({
        project_id: entry.project_id,
        start_date: entry.date,
        end_date: entry.date,
        status: "draft",
        created_by: callerUid,
        created_via: "ai",
      })
      .select("id")
      .single();
    if (insertError || !created) {
      results.push({
        ...entry,
        ok: false,
        reason: "write_failed",
        detail: String((insertError as { message?: string } | null)?.message ?? "unknown error"),
      });
      continue;
    }
    const assignmentId = (created as { id: string }).id;
    const { error: memberError } = await client.from("schedule_assignment_members").insert({
      assignment_id: assignmentId,
      profile_id: entry.profile_id,
      role: crewMemberRole(profile.role),
    });
    if (memberError) {
      // A memberless assignment renders nothing on the board either way;
      // clean it up so it doesn't linger as an empty row.
      await client.from("schedule_assignments").delete().eq("id", assignmentId);
      results.push({
        ...entry,
        ok: false,
        reason: "write_failed",
        detail: String((memberError as { message?: string }).message ?? "unknown error"),
      });
      continue;
    }
    try {
      await client
        .from("schedule_events")
        .insert({ assignment_id: assignmentId, actor: callerUid, kind: "created", payload: { ai: true } });
    } catch (_e) {
      // audit is optional, matches lib/schedule/api.ts's own logEvent
    }

    drafted++;
    results.push({ ...entry, ok: true });
    const claimed = claimedThisCall.get(entry.profile_id) ?? [];
    claimed.push({ start: entry.date, end: entry.date, project_id: entry.project_id });
    claimedThisCall.set(entry.profile_id, claimed);
  }

  return { content: JSON.stringify({ results, drafted, refused: results.length - drafted }) };
}

/** clear_ai_drafts' write: deletes ONLY status='draft' AND created_via='ai'
 * rows in range — published rows and a human's own drafts are never even
 * selected, let alone touched. Members cascade off the delete
 * (schedule_assignment_members' own FK, unchanged since 20260721010000). */
async function executeClearAiDrafts(
  client: SupabaseLike,
  callerUid: string,
  from: string,
  to: string,
  projectId: string | null,
): Promise<{ content: string; is_error?: boolean }> {
  let query = client
    .from("schedule_assignments")
    .select("id")
    .eq("status", "draft")
    .eq("created_via", "ai")
    .lte("start_date", to)
    .gte("end_date", from);
  if (projectId) query = query.eq("project_id", projectId);

  const { data: rows, error } = await query;
  if (error) return { content: "Couldn't read the existing drafts — try again.", is_error: true };

  const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return { content: JSON.stringify({ removed: 0 }) };

  const { error: deleteError } = await client.from("schedule_assignments").delete().in("id", ids);
  if (deleteError) return { content: "Couldn't clear the drafts — try again.", is_error: true };

  for (const id of ids) {
    try {
      await client
        .from("schedule_events")
        .insert({ assignment_id: id, actor: callerUid, kind: "removed", payload: { ai: true } });
    } catch (_e) {
      // audit is optional
    }
  }

  return { content: JSON.stringify({ removed: ids.length }) };
}

/** The executeTool dispatcher anthropicToolChat calls. One rank check up
 * front covers all three tools (PERMISSION MIRROR); a tool that throws is
 * caught here so a DB hiccup degrades to a plain retry line instead of
 * taking the whole ask() request down. */
function buildSchedulingExecutor(
  client: SupabaseLike,
  callerUid: string,
  rank: number,
): (name: string, input: unknown) => Promise<{ content: string; is_error?: boolean }> {
  return async (name, input) => {
    const refusal = schedulingRefusal(rank);
    if (refusal) return { content: refusal };

    try {
      switch (name) {
        case "get_scheduling_picture": {
          const parsed = parseDateRangeInput(input);
          if (parsed.formatError) return { content: parsed.formatError, is_error: true };
          const picture = await buildSchedulingPicture(client, parsed.from, parsed.to);
          return { content: JSON.stringify(picture) };
        }
        case "draft_assignments":
          return await executeDraftAssignments(client, callerUid, input);
        case "clear_ai_drafts": {
          const parsed = parseDateRangeInput(input);
          if (parsed.formatError) return { content: parsed.formatError, is_error: true };
          return await executeClearAiDrafts(client, callerUid, parsed.from, parsed.to, parsed.projectId);
        }
        default:
          return { content: `Unknown tool: ${name}`, is_error: true };
      }
    } catch (e) {
      console.error("scheduling tool failed", name, e);
      return { content: "Something went wrong reading or writing the schedule — try again.", is_error: true };
    }
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }
  const userId = auth.status === "ok" ? auth.user.id : null;

  try {
    const body = await req.json().catch(() => ({}));
    const question = String(body.question ?? "").trim();
    if (!question) {
      return jsonResponse({ error: "question is required" }, 400, cors);
    }
    const history: HistoryTurn[] = Array.isArray(body.history)
      ? body.history
          .filter(
            (h: unknown): h is HistoryTurn =>
              !!h &&
              typeof (h as HistoryTurn).content === "string" &&
              ((h as HistoryTurn).role === "user" ||
                (h as HistoryTurn).role === "assistant"),
          )
          .slice(-8)
      : [];

    // Without the Anthropic key this function cannot spend a cent, so there is
    // nothing to meter — and metering anyway would charge somebody's daily
    // allowance for a call that was always free. Hence this sits BEFORE the
    // guard, and answers the way a refusal does: an empty answer, which is
    // already the client's signal to serve the company brain. The brain is
    // where the answer comes from either way, so this is a silent fall-through
    // rather than the 500 it used to be.
    if (!ANTHROPIC_API_KEY) {
      return jsonResponse({ answer: "", sources: [] }, 200, cors);
    }

    // ---- Spend guard -------------------------------------------------------
    // Placed immediately before the first thing that can cost money, and after
    // everything that cannot. Nothing above this line spends, so nothing above
    // it is metered. Two facts make that the whole ballgame:
    //
    //  - A question the company brain can answer never reaches this function.
    //    AskInfinity.tsx tries cached live data, then the bundled brain, and
    //    only calls here when both came up empty (see step 3 there). Free
    //    answers therefore cost nobody a question from their daily 40.
    //  - A question that arrives when we cannot pay returns above, unmetered.
    //
    // A refusal is a 200 with an empty `answer` and a `note`, never an error, so
    // an installer at a jobsite gets a real answer whether or not a budget ran
    // out. See docs/ai-spend-limits.md.
    const meter =
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        : null;
    const gate = await reserveAiSpend(meter, {
      userId: userId === "service_role" ? null : userId,
      functionName: "ask",
    });
    if (gate.alert) {
      await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      });
    }
    if (!gate.allowed) {
      return jsonResponse(
        { answer: "", sources: [], limited: true, limit_reason: gate.reason, note: gate.note },
        200,
        cors,
      );
    }

    // (a) + (b) retrieve vault chunks (RAG) and (c) a compact live-data
    // snapshot. RAG is OPTIONAL: it needs OpenAI embeddings, so if no OpenAI key
    // is set (or embedding / the RPC fails) we simply answer from live data
    // only. This step must NEVER throw the whole function.
    let chunks: ReturnType<typeof shapeMatches> = [];
    let live: LiveContext = {};
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      if (Deno.env.get("OPENAI_API_KEY")) {
        try {
          const [queryEmbedding] = await embed([question]);
          const { data } = await supabase.rpc("match_knowledge_chunks", {
            query_embedding: queryEmbedding,
            match_count: 8,
            min_similarity: 0.0,
          });
          chunks = shapeMatches(data);
        } catch (_e) {
          // no-op: embeddings/RAG unavailable → answer from live data only.
          chunks = [];
        }
      }
      live = await loadLiveContext(supabase, userId);
    }

    // (d) ground Claude with the assembled context. Wave A2: the scheduling
    // toolset is offered whenever the caller has a real JWT to scope a
    // client to (never for a service_role/unconfigured caller, which keeps
    // today's plain-chat behavior exactly). See the header comment above
    // buildSchedulingExecutor for why THAT client, not the service-role one
    // used above, is what makes the supervisor-rank gate real.
    const contextBlock = buildContextBlock(chunks, live);
    const messages = buildAnthropicMessages(
      history,
      buildAskUserMessage(question, contextBlock),
    );
    const schedulingCallerId = userId && userId !== "service_role" ? userId : null;
    const scopedClient = schedulingCallerId ? callerSupabaseClient(req) : null;

    let usage: AnthropicUsage | null = null;
    let answer: string;
    let toolActivity: string[] = [];
    try {
      if (scopedClient && schedulingCallerId) {
        const rank = await callerRank(scopedClient);
        const result = await anthropicToolChat({
          system: SYSTEM_PROMPT,
          messages,
          tools: SCHEDULING_TOOLS,
          executeTool: buildSchedulingExecutor(scopedClient, schedulingCallerId, rank),
        });
        answer = result.text;
        usage = result.usage;
        toolActivity = result.toolCalls.map((c) => toolActivityLine(c.name, c.input));
        if (!answer && result.truncated) {
          // The round-trip ceiling hit mid-tool-use. Whatever draft_assignments
          // already committed is real (each call writes as it goes) — it just
          // never got narrated, so say that rather than hand back silence.
          answer =
            "I got partway through that plan and ran out of room to finish " +
            "explaining it. Check Scheduling for what's drafted so far — " +
            "nothing has published.";
        }
      } else {
        answer = await anthropicChat({
          system: ASK_SYSTEM_PROMPT,
          messages,
          onUsage: (u) => {
            usage = u;
          },
        });
      }
    } catch (e) {
      // Refund the money, keep the call count: a client stuck in a retry loop is
      // the runaway this guards against, and it must still run out of quota.
      await releaseAiSpend(meter, gate.reservationId, "provider_failed", false);
      throw e;
    }
    await settleAiSpend(meter, gate.reservationId, usage, ANTHROPIC_MODEL);

    return jsonResponse(
      {
        answer,
        sources: dedupeSources(chunks),
        ...(toolActivity.length > 0 ? { toolActivity } : {}),
      },
      200,
      cors,
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

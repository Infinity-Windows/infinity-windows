import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  embed,
  jsonResponse,
  requireOpenAI,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import { verifyCaller } from "../_shared/auth.ts";
import {
  ASK_SYSTEM_PROMPT,
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

interface HistoryTurn {
  role: string;
  content: string;
}

/** The set of project ids the asking user is on: the crews they're scheduled on
 * plus any openings assigned to them. Mirrors the `can_access_project_chat`
 * membership test and is reused to scope BOTH an installer's issues and their
 * job chat to jobs they can actually reach. Best-effort — degrades to empty. */
async function loadMyProjectIds(
  supabase: ReturnType<typeof createClient>,
  userId: string,
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
    const { data: openingRows } = await supabase
      .from("project_openings")
      .select("project_id")
      .eq("assigned_to", userId);
    for (const o of openingRows ?? []) {
      if (o.project_id) projectIds.add(o.project_id as string);
    }
  } catch (_e) {
    // no-op: assigned openings unavailable
  }
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
          .select("start_date, end_date, start_time, status, projects(name, job_code)")
          .in("id", ids)
          .eq("status", "published")
          .gte("end_date", today)
          .order("start_date")
          .limit(15);
        live.schedule = (assignments ?? []).map((a) => {
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

  // (B) The asking user's own assigned windows/doors + where each unit is (all
  // roles). Joins opening → assigned unit → warehouse location so the AI can
  // answer "what am I assigned and where are the units?".
  if (userId) {
    try {
      const { data } = await supabase
        .from("project_openings")
        .select(
          "opening_code, label, status, window_types(category), windows(window_id, status, locations(address)), projects(name, job_code)",
        )
        .eq("assigned_to", userId)
        .order("sequence", { nullsFirst: false })
        .limit(40);
      if (data && data.length > 0) {
        live.assignments = data.map((o) => {
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
    ? await loadMyProjectIds(supabase, userId)
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
        .select("kind, urgency, note, created_at, projects(name, job_code)")
        .eq("status", "open");
      if (scope === "own-jobs") {
        filter = filter.in("project_id", [...myProjects]);
      }
      const { data } = await filter
        .order("created_at", { ascending: false })
        .limit(20);
      if (data) {
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
    const key = requireOpenAI();
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

    // (a) embed the question.
    const [queryEmbedding] = await embed([question]);

    // (b) + (c) retrieve vault chunks and a compact live-data snapshot.
    let chunks: ReturnType<typeof shapeMatches> = [];
    let live: LiveContext = {};
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      try {
        const { data } = await supabase.rpc("match_knowledge_chunks", {
          query_embedding: queryEmbedding,
          match_count: 8,
          min_similarity: 0.0,
        });
        chunks = shapeMatches(data);
      } catch (_e) {
        // no-op: RAG store not applied yet → answer from live data only.
      }
      live = await loadLiveContext(supabase, userId);
    }

    // (d) ground gpt-4o with the assembled context.
    const contextBlock = buildContextBlock(chunks, live);
    const messages = [
      { role: "system", content: ASK_SYSTEM_PROMPT },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: buildAskUserMessage(question, contextBlock) },
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", temperature: 0.2, messages }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI chat failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    const answer = String(data.choices?.[0]?.message?.content ?? "").trim();

    return jsonResponse(
      { answer, sources: dedupeSources(chunks) },
      200,
      cors,
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

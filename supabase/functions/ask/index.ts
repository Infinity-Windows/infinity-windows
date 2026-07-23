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

interface HistoryTurn {
  role: string;
  content: string;
}

/** Best-effort compact snapshot of live app data for grounding. Every query
 * degrades to empty so a missing table/column never breaks the answer. */
async function loadLiveContext(
  supabase: ReturnType<typeof createClient>,
  userId: string | null,
): Promise<LiveContext> {
  const live: LiveContext = {};
  const today = new Date().toISOString().slice(0, 10);

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

  // Open issues (company-wide): compact list of what's currently broken/blocked.
  try {
    const { data } = await supabase
      .from("issues")
      .select("kind, urgency, note, created_at, projects(name, job_code)")
      .eq("status", "open")
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

    // Top on-hand types: aggregate a bounded projection client-side (indexed on
    // status) so we can answer "how many X do we have" without a per-type query.
    try {
      const { data } = await supabase
        .from("windows")
        .select("window_types(type_code, name)")
        .in("status", ["in_warehouse", "staged"])
        .limit(3000);
      if (data && data.length > 0) {
        const counts = new Map<string, { type_code?: string; name?: string; count: number }>();
        for (const row of data) {
          const wt = row.window_types as { type_code?: string; name?: string } | null;
          const key = (wt?.type_code ?? wt?.name ?? "").trim();
          if (!key) continue;
          const cur = counts.get(key);
          if (cur) cur.count += 1;
          else counts.set(key, { type_code: wt?.type_code, name: wt?.name, count: 1 });
        }
        inventory.topOnHand = [...counts.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 15);
      }
    } catch (_e) {
      // no-op: per-type rollup unavailable
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

  // Recent job chat, scoped to jobs the ASKING USER is on (never leak other
  // crews' threads). Mirrors can_access_project_chat: schedule crew + assigned
  // openings decide which projects' messages this user may see.
  if (userId) {
    try {
      const projectIds = new Set<string>();
      const { data: memberRows } = await supabase
        .from("schedule_assignment_members")
        .select("schedule_assignments(project_id)")
        .eq("profile_id", userId);
      for (const m of memberRows ?? []) {
        const a = m.schedule_assignments as { project_id?: string } | null;
        if (a?.project_id) projectIds.add(a.project_id);
      }
      const { data: openingRows } = await supabase
        .from("project_openings")
        .select("project_id")
        .eq("assigned_to", userId);
      for (const o of openingRows ?? []) {
        if (o.project_id) projectIds.add(o.project_id as string);
      }

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

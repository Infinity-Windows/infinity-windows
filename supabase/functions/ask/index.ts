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

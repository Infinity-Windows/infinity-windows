import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  chatJson,
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";

interface SynthesisResult {
  tips: string[];
  watch_outs: string[];
  outcome_difficulty: number;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const minInstalls = Number(body.min_installs ?? 3);
    const typeIdFilter = typeof body.type_id === "string" ? body.type_id : null;

    let typesQuery = supabase
      .from("window_types")
      .select("id, type_code, name, tips_json, watch_outs_json, difficulty_rating");
    if (typeIdFilter) typesQuery = typesQuery.eq("id", typeIdFilter);
    const { data: types, error: typeErr } = await typesQuery;
    if (typeErr) throw typeErr;

    const results: { type_code: string; updated: boolean; installs: number }[] =
      [];

    for (const t of types ?? []) {
      const { data: events, error: evErr } = await supabase
        .from("install_events")
        .select(
          "minutes, quality_grade, difficulty, went_well, went_poorly, obstacles, tools_helped, safety_notes, do_again, transcript_raw",
        )
        .eq("window_type_id", t.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (evErr) throw evErr;
      if (!events || events.length < minInstalls) {
        results.push({
          type_code: t.type_code,
          updated: false,
          installs: events?.length ?? 0,
        });
        continue;
      }

      const memoBlob = events
        .map((e, i) => {
          const parts = [
            `# Install ${i + 1}`,
            e.minutes != null ? `minutes: ${e.minutes}` : null,
            e.quality_grade != null ? `grade: ${e.quality_grade}/5` : null,
            e.difficulty && `difficulty: ${e.difficulty}`,
            e.went_well && `went_well: ${e.went_well}`,
            e.went_poorly && `went_poorly: ${e.went_poorly}`,
            e.obstacles && `obstacles: ${e.obstacles}`,
            e.tools_helped && `tools: ${e.tools_helped}`,
            e.safety_notes && `safety: ${e.safety_notes}`,
            e.do_again && `do_again: ${e.do_again}`,
            e.transcript_raw && `transcript: ${e.transcript_raw.slice(0, 1500)}`,
          ].filter(Boolean);
          return parts.join("\n");
        })
        .join("\n\n");

      const existingTips = Array.isArray(t.tips_json) ? t.tips_json : [];
      const existingWatch = Array.isArray(t.watch_outs_json)
        ? t.watch_outs_json
        : [];

      const synthesis = await chatJson<SynthesisResult>(
        `You synthesize installer learning for window type ${t.type_code} (${t.name}). Mine practical tips and watch-outs from real install memos. Prefer concrete, actionable lines. Keep the best prior tips when still valid.`,
        `Prior tips: ${JSON.stringify(existingTips)}\nPrior watch-outs: ${JSON.stringify(existingWatch)}\n\nInstall memos:\n${memoBlob}`,
        `Schema: { "tips": string[5], "watch_outs": string[3-5], "outcome_difficulty": number 1-5 }`,
      );

      const tips = (synthesis.tips ?? [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 5);
      const watch_outs = (synthesis.watch_outs ?? [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 5);
      let outcome = Number(synthesis.outcome_difficulty);
      if (!Number.isFinite(outcome) || outcome < 1 || outcome > 5) {
        outcome = t.difficulty_rating ?? 3;
      }

      const { error: upErr } = await supabase
        .from("window_types")
        .update({
          tips_json: tips,
          watch_outs_json: watch_outs,
          outcome_difficulty: Math.round(outcome),
          tips_synthesized_at: new Date().toISOString(),
          tips_install_count: events.length,
        })
        .eq("id", t.id);
      if (upErr) throw upErr;

      results.push({
        type_code: t.type_code,
        updated: true,
        installs: events.length,
      });
    }

    return jsonResponse({ ok: true, results }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

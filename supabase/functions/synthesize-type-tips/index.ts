import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_MODEL,
  anthropicChatJson,
  requireAnthropic,
} from "../_shared/anthropic.ts";
import { verifyCaller } from "../_shared/auth.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";

interface SynthesisResult {
  tips: string[];
  watch_outs: string[];
  outcome_difficulty: number;
}

const TIPS_SCHEMA = {
  type: "object",
  properties: {
    tips: { type: "array", items: { type: "string" } },
    watch_outs: { type: "array", items: { type: "string" } },
    outcome_difficulty: { type: "number" },
  },
  required: ["tips", "watch_outs", "outcome_difficulty"],
};

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }
  const callerId =
    auth.status === "ok" && auth.user.id !== "service_role" ? auth.user.id : null;

  try {
    // Claude writes the tips, so the Anthropic key is the only hard dependency.
    requireAnthropic();
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

    const results: {
      type_code: string;
      updated: boolean;
      installs: number;
      limited?: boolean;
    }[] = [];
    // Set when the company ceiling refuses a type: stop asking for more rather
    // than hammering a closed door for the other hundred types.
    let limited = false;

    for (const t of types ?? []) {
      if (limited) {
        results.push({ type_code: t.type_code, updated: false, installs: 0, limited: true });
        continue;
      }
      const { data: events, error: evErr } = await supabase
        .from("install_events")
        .select(
          "minutes, quality_grade, difficulty, went_well, went_poorly, obstacles, tools_helped, safety_notes, do_again, time_vs_estimate, transcript_raw",
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
            e.time_vs_estimate && `time_vs_estimate: ${e.time_vs_estimate}`,
            e.transcript_raw && `transcript: ${e.transcript_raw.slice(0, 1500)}`,
          ].filter(Boolean);
          return parts.join("\n");
        })
        .join("\n\n");

      // Time context so tips can call out where installs actually run long.
      const mins = events
        .map((e) => e.minutes)
        .filter((m: number | null): m is number => m != null)
        .sort((a: number, b: number) => a - b);
      const median = mins.length ? mins[Math.floor(mins.length / 2)] : null;
      const p90 = mins.length ? mins[Math.floor(mins.length * 0.9)] : null;
      const grades = events
        .map((e) => e.quality_grade)
        .filter((g: number | null): g is number => g != null);
      const failRate = grades.length
        ? Math.round((grades.filter((g: number) => g <= 2).length / grades.length) * 100)
        : null;

      const existingTips = Array.isArray(t.tips_json) ? t.tips_json : [];
      const existingWatch = Array.isArray(t.watch_outs_json)
        ? t.watch_outs_json
        : [];

      // Spend guard, per window type — one type is one paid call ($0.0009), so
      // metering per type is what makes the owner screen's per-function total
      // real. Write-time work: no role floor, no daily count, ceiling only.
      const gate = await reserveAiSpend(supabase, {
        userId: callerId,
        functionName: "synthesize-type-tips",
      });
      if (gate.alert) {
        await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
          supabaseUrl: SUPABASE_URL,
          serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
        });
      }
      if (!gate.allowed) {
        limited = true;
        results.push({
          type_code: t.type_code,
          updated: false,
          installs: events.length,
          limited: true,
        });
        continue;
      }

      let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
      const synthesis = await anthropicChatJson<SynthesisResult>({
        system:
          `You write field-ready coaching for window type ${t.type_code} (${t.name}) for the NEXT installer. Rules: every tip must be specific and actionable — name the step, the part, the tool, or the failure it prevents (e.g. "Pre-drill the hinge side; last installs cammed out screws there"). No generic advice ("work carefully", "measure twice"). Base every line on the memos below. Watch-outs are the concrete failure modes that cost time or grade. Keep the best prior lines when still true; drop anything vague. Order tips by impact on time/quality.`,
        user:
          `Stats: median ${median ?? "?"}m, P90 ${p90 ?? "?"}m, fail rate ${failRate ?? "?"}%.\nPrior tips: ${JSON.stringify(existingTips)}\nPrior watch-outs: ${JSON.stringify(existingWatch)}\n\nInstall memos:\n${memoBlob}`,
        schemaHint:
          `Schema: { "tips": string[3-5, specific+actionable], "watch_outs": string[2-5, concrete failure modes], "outcome_difficulty": number 1-5 }`,
        schema: TIPS_SCHEMA,
        onUsage: (u) => {
          usage = u;
        },
      }).catch(async (err) => {
        await releaseAiSpend(supabase, gate.reservationId, "provider_failed", false);
        throw err;
      });
      await settleAiSpend(supabase, gate.reservationId, usage, ANTHROPIC_MODEL);

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

    return jsonResponse(
      {
        ok: true,
        results,
        ...(limited
          ? {
              limited: true,
              note: "Stopped early: the company's monthly AI budget is used up. An owner can raise the ceiling on the AI spend screen.",
            }
          : {}),
      },
      200,
      cors,
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

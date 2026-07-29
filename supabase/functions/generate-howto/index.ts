import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  chatJson,
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import { verifyCaller } from "../_shared/auth.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";

interface HowtoResult {
  steps: { title: string; detail: string }[];
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }
  const callerId =
    auth.status === "ok" && auth.user.id !== "service_role" ? auth.user.id : null;

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const typeId = body.type_id as string | undefined;
    if (!typeId) return jsonResponse({ error: "type_id required" }, 400, cors);

    const { data: type, error: tErr } = await supabase
      .from("window_types")
      .select(
        "id, type_code, name, tips_json, watch_outs_json, golden_install_event_id",
      )
      .eq("id", typeId)
      .single();
    if (tErr) throw tErr;

    // Golden install (or most recent good one) supplies the concrete narrative.
    let golden: Record<string, unknown> | null = null;
    if (type.golden_install_event_id) {
      const { data } = await supabase
        .from("install_events")
        .select(
          "difficulty, went_well, went_poorly, obstacles, tools_helped, safety_notes, do_again, transcript_raw, photo_findings, minutes",
        )
        .eq("id", type.golden_install_event_id)
        .maybeSingle();
      golden = data;
    }

    if (!golden) {
      return jsonResponse(
        { skipped: true, reason: "no golden install yet" },
        200,
        cors,
      );
    }

    // Spend guard, write-time: one how-to per window type, owner-triggered,
    // $0.0009 a go. Ceiling only — no role floor, no daily count. Placed after
    // the "no golden install yet" skip above so a skipped type books nothing.
    const gate = await reserveAiSpend(supabase, {
      userId: callerId,
      functionName: "generate-howto",
    });
    if (gate.alert) {
      await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      });
    }
    if (!gate.allowed) {
      return jsonResponse(
        {
          skipped: true,
          limited: true,
          limit_reason: gate.reason,
          reason: "the company's monthly AI budget is used up",
        },
        200,
        cors,
      );
    }

    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    const result = await chatJson<HowtoResult>(
      `You write a concise, field-ready how-to for installing window type ${type.type_code} (${type.name}), aimed at a newer installer. Ground every step in the reference install and tips below. 5-9 steps, each a short imperative title + 1-2 sentence detail. Include the known watch-outs where relevant. No fluff.`,
      `Tips: ${JSON.stringify(type.tips_json ?? [])}\nWatch-outs: ${JSON.stringify(type.watch_outs_json ?? [])}\nReference install: ${JSON.stringify(golden)}`,
      `Schema: { "steps": [ { "title": string, "detail": string } ] }`,
      (u) => {
        usage = u;
      },
    ).catch(async (err) => {
      await releaseAiSpend(supabase, gate.reservationId, "provider_failed", false);
      throw err;
    });
    await settleAiSpend(supabase, gate.reservationId, usage, "gpt-4o-mini");

    const steps = (result.steps ?? [])
      .map((s) => ({
        title: String(s.title ?? "").trim(),
        detail: String(s.detail ?? "").trim(),
      }))
      .filter((s) => s.title)
      .slice(0, 9);

    const { error: upErr } = await supabase
      .from("window_types")
      .update({ howto_json: steps, howto_generated_at: new Date().toISOString() })
      .eq("id", typeId);
    if (upErr) throw upErr;

    return jsonResponse({ ok: true, steps: steps.length }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

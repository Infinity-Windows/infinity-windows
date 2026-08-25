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

/** What the model sends back. Typed loosely on purpose: the schema asks for a
 * title and a detail per step, and a model that answers with a bare sentence has
 * still answered. Pretending otherwise in the types just moves the shrug from
 * the code into the compiler. */
interface HowtoResult {
  steps: (string | { title?: string; detail?: string })[];
}

const HOWTO_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
        },
        required: ["title", "detail"],
      },
    },
  },
  required: ["steps"],
};

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
    // The one hard dependency is now the Anthropic key: Claude writes the
    // how-to. No OpenAI key is needed to run this function at all.
    requireAnthropic();
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

    // A step that arrives as a plain sentence instead of a title-and-detail pair
    // is still a step. Dropping it because it is the wrong shape is how a guide
    // ends up empty, which is the failure this migration has to stop.
    const readSteps = (result: HowtoResult) =>
      (Array.isArray(result.steps) ? result.steps : [])
        .map((s) =>
          typeof s === "string"
            ? { title: s.trim(), detail: "" }
            : {
              title: String(s?.title ?? "").trim(),
              detail: String(s?.detail ?? "").trim(),
            },
        )
        .filter((s) => s.title)
        .slice(0, 9);

    const generate = (extra: string) => {
      // What the earlier attempt cost. The totals onUsage reports are per call,
      // so a retry has to add to them, not replace them.
      const spent = usage;
      return anthropicChatJson<HowtoResult>({
        system:
          `You write a concise, field-ready how-to for installing window type ${type.type_code} (${type.name}), aimed at a newer installer. Ground every step in the reference install and tips below. 5-9 steps, each a short imperative title + 1-2 sentence detail. Include the known watch-outs where relevant. No fluff.${extra}`,
        user:
          `Tips: ${JSON.stringify(type.tips_json ?? [])}\nWatch-outs: ${JSON.stringify(type.watch_outs_json ?? [])}\nReference install: ${JSON.stringify(golden)}`,
        schemaHint: `Schema: { "steps": [ { "title": string, "detail": string } ] }`,
        schema: HOWTO_SCHEMA,
        onUsage: (u) => {
          usage = {
            inputTokens: (spent?.inputTokens ?? 0) + (u.inputTokens ?? 0),
            outputTokens: (spent?.outputTokens ?? 0) + (u.outputTokens ?? 0),
          };
        },
      }).catch(async (err) => {
        await releaseAiSpend(supabase, gate.reservationId, "provider_failed", false);
        throw err;
      });
    };

    let steps = readSteps(await generate(""));

    // One firmer retry before refusing. The deploy smoke went red on both
    // attempts of the same run (2026-08-24): the one window type with a golden
    // install has a reference row that is null in every narrative field, and
    // the model kept answering "ground every step in the reference install"
    // with steps: [] — schema-valid, so the save guard below was the first
    // thing to object. Naming the emptiness costs $0.0009 more; a red deploy
    // costs a morning. Once only, the same rule as the repair pass in
    // anthropicChatJson: a model that will not answer twice will not answer
    // five times either.
    if (steps.length === 0) {
      steps = readSteps(
        await generate(
          " IMPORTANT: a previous attempt at this request returned an empty steps array, which is never a valid answer. Reply with the steps array only; at least 3 steps, each with a non-empty title and detail. If the reference install is thin, ground the steps in the tips and watch-outs below instead.",
        ),
      );
    }

    await settleAiSpend(supabase, gate.reservationId, usage, ANTHROPIC_MODEL);

    // Never write a guide with nothing in it. `howto_json` is replaced outright,
    // so an answer that arrives with no steps would blank an existing guide and
    // report success — the failure nobody sees until an installer opens it on a
    // roof. Refusing costs one regenerate; saving costs the guide.
    if (steps.length === 0) {
      throw new Error(
        "the AI returned a how-to with no steps in it, so nothing was saved",
      );
    }

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

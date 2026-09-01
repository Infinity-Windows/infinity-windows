import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL,
  anthropicChat,
  type AnthropicUsage,
} from "../_shared/anthropic.ts";
import { verifyCaller } from "../_shared/auth.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";
import { buildAnthropicMessages } from "../_shared/knowledge.ts";
import {
  buildStudioAssistUserMessage,
  checkModelSize,
  STUDIO_ASSIST_SYSTEM_PROMPT,
  type HistoryTurn,
} from "../_shared/studioAssist.ts";

/**
 * Model Studio's "Ask about this model" assistant (Studio 100x #42). Mirrors
 * `ask/index.ts`'s shape end to end — same auth, same spend-guard plumbing,
 * same non-streaming plain-text `anthropicChat` call, same degrade-to-200
 * voice on a declined spend — because that function is the house pattern for
 * "a person taps a button and gets a paid AI answer," and this is exactly
 * that with a different context block (a serialized floor instead of live
 * job data).
 *
 * What's different from `ask`: the context here is the CLIENT's job, not
 * this function's. The client already ran the floor through
 * simplifyCanvasData and enforced the ~8KB size cap before this request was
 * ever sent (see aiAssist.ts) — `model` arrives pre-simplified. This
 * function re-checks the size as cheap defense in depth, but the real gate
 * is client-side, on purpose: refusing a huge floor before paying for the
 * network round trip.
 *
 * The reply may contain one fenced ```json {"action":"add_unit",...}``` block
 * (see the system prompt in `_shared/studioAssist.ts`). This function does
 * NOT parse it — it hands the raw text back exactly like `ask` hands back
 * its answer, and the client (which already has the live wall list and the
 * `insertUnit` path a human drag-drop uses) is what turns that block into an
 * Insert/Dismiss proposal card.
 */
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
    if (!body.model || typeof body.model !== "object") {
      return jsonResponse({ error: "model is required" }, 400, cors);
    }
    const modelJson = JSON.stringify(body.model);
    const sizeCheck = checkModelSize(modelJson);
    if (!sizeCheck.ok) {
      // Same voice as the client-side refusal — this path is defense in
      // depth against a bypassed/buggy client, not the primary gate, but an
      // installer who somehow reaches it should still get plain words.
      return jsonResponse({ error: sizeCheck.message }, 400, cors);
    }
    const catalogJson = JSON.stringify(
      Array.isArray(body.unitCatalogSummary) ? body.unitCatalogSummary : [],
    );
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

    // Without the Anthropic key this function cannot spend a cent, so there
    // is nothing to meter — see ask/index.ts for why this sits BEFORE the
    // guard. A blank answer is the client's signal there's nothing to show.
    if (!ANTHROPIC_API_KEY) {
      return jsonResponse({ answer: "" }, 200, cors);
    }

    // ---- Spend guard -------------------------------------------------------
    // Identical shape to ask/index.ts: reserve before the paid call, settle
    // with the provider's real token counts after, release on failure. A
    // question-kind reservation, so it shares the same per-user daily count
    // and role floor as Ask Forge — one "AI questions today" budget, not
    // a second one this feature would otherwise sneak past. See
    // docs/ai-spend-limits.md.
    const meter =
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        : null;
    const gate = await reserveAiSpend(meter, {
      userId: userId === "service_role" ? null : userId,
      functionName: "studio-assist",
    });
    if (gate.alert) {
      await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      });
    }
    if (!gate.allowed) {
      return jsonResponse(
        { answer: "", limited: true, limit_reason: gate.reason, note: gate.note },
        200,
        cors,
      );
    }

    const messages = buildAnthropicMessages(
      history,
      buildStudioAssistUserMessage(question, modelJson, catalogJson),
    );

    let usage: AnthropicUsage | null = null;
    let answer: string;
    try {
      answer = await anthropicChat({
        system: STUDIO_ASSIST_SYSTEM_PROMPT,
        messages,
        onUsage: (u) => {
          usage = u;
        },
      });
    } catch (e) {
      // Refund the money, keep the call count — same reasoning as ask: a
      // client stuck retrying must still run out of quota.
      await releaseAiSpend(meter, gate.reservationId, "provider_failed", false);
      throw e;
    }
    await settleAiSpend(meter, gate.reservationId, usage, ANTHROPIC_MODEL);

    return jsonResponse({ answer }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

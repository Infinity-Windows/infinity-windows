import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import { corsHeaders, jsonResponse, requireOpenAI, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../_shared/openai.ts";
import { notifyOwnersOfSpend, releaseAiSpend, reserveAiSpend, settleAiSpend } from "../_shared/spendGuard.ts";
import { reportCaughtError, withSentry } from "../_shared/sentry.ts";
import { DICTATION_MAX_SECONDS } from "../_shared/dictation.ts";

/**
 * Live Ask: exchanges the phone's WebRTC offer with GPT-Live and returns the
 * answer. The OpenAI key stays here; the phone gets SDP and nothing else.
 *
 * OFF unless LIVE_ASK_ENABLED=true. The endpoint and JSON session/transport
 * shape were checked against OpenAI's GPT-Live WebRTC guide (2026-09-30).
 *
 * Money: the session books four minutes at the published $0.05/min rate:
 * the 180-second cap plus up to one minute for the server expiry sweep.
 * Actual usage arrives on the browser data channel;
 * a future trusted reconciliation path must replace this cap charge before
 * the owner's spend screen can call it actual. Unmetered starts are refused.
 */

const MODEL = "gpt-live-1";
/** Pilot cap: also the memo limit, so every recorded segment fits one memo. */
const MAX_SECONDS = DICTATION_MAX_SECONDS;
const MICROS_PER_MINUTE = 50_000;
const MAX_OFFER_BYTES = 20_000;

const INSTRUCTIONS = [
  "You are the voice of Forge Ask for a window installation crew. Speak English or Spanish, whichever the person uses. Speak at a brisk, natural pace with short pauses between phrases. Keep routine replies to one or two short sentences.",
  "You know nothing about this company, its jobs, units, schedules, time clocks, people, procedures or products. For ANY such question or request, delegate it; never answer it from your own knowledge and never guess.",
  "When a delegation result comes back, say only what it says. Never say anything was saved, started, stopped, clocked or changed unless the result says so. If the result says a choice needs a tap on the screen, tell the person to tap it; you cannot confirm anything for them.",
  "If the result says nothing was sent or saved, say that plainly.",
].join("\n");

export function liveEnabled(env: (k: string) => string | undefined): boolean {
  return env("LIVE_ASK_ENABLED") === "true";
}

Deno.serve(withSentry("live-ask-session", async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, cors);
  const auth = await verifyCaller(req);
  if (auth.status !== "ok" || auth.user.id === "service_role") return jsonResponse({ error: "sign_in_required" }, 401, cors);
  const caller = callerSupabaseClient(req);
  if (!caller) return jsonResponse({ error: "sign_in_required" }, 401, cors);
  // `active` is On site / Off today, not login access: gate on these two.
  const { data: profile, error: profileError } = await caller.from("profiles")
    .select("id, is_partner, access_revoked_at, retired_at").eq("id", auth.user.id).maybeSingle();
  if (profileError || !profile || profile.is_partner || profile.access_revoked_at || profile.retired_at) return jsonResponse({ error: "access_unavailable" }, 403, cors);
  // Keep the pilot limited to the owner even if a client build exposes the
  // button. The wider crew release needs its own field acceptance first.
  const { data: rank, error: rankError } = await caller.rpc("my_role_rank");
  if (rankError || typeof rank !== "number" || rank < 3) return jsonResponse({ error: "owner_pilot_only" }, 403, cors);

  const config = liveEnabled((k) => Deno.env.get(k));
  if (!config) return jsonResponse({ error: "live_not_configured" }, 503, cors);

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_OFFER_BYTES) return jsonResponse({ error: "invalid_offer" }, 413, cors);
  let sdp = "";
  try { const body = JSON.parse(raw); sdp = typeof body?.sdp === "string" ? body.sdp : ""; } catch { /* below */ }
  if (!sdp.startsWith("v=0")) return jsonResponse({ error: "invalid_offer" }, 400, cors);

  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const gate = await reserveAiSpend(service, { userId: auth.user.id, functionName: "live-ask-session" });
  if (gate.alert) await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, { supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY });
  if (!gate.allowed) return jsonResponse({ error: "live_limit", note: gate.note }, 429, cors);
  if (!gate.reservationId) return jsonResponse({ error: "live_unmetered" }, 503, cors);
  const reservation = gate.reservationId;
  let reached = false;
  let createdSessionId: string | null = null;
  let expiryRegistered = false;
  try {
    const key = requireOpenAI();
    reached = true;
    const response = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: { model: MODEL, delegation: { type: "client" }, instructions: INSTRUCTIONS },
        transport: { type: "webrtc", sdp },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json().catch(() => null);
    const answer = result?.transport?.sdp;
    const sessionId = result?.session?.id;
    if (!response.ok || typeof answer !== "string" || !answer.startsWith("v=") || typeof sessionId !== "string" || !/^live_[A-Za-z0-9_-]{1,120}$/.test(sessionId)) throw new Error(`live_provider_${response.status}`);
    createdSessionId = sessionId;
    const registered = await service.from("live_ask_provider_sessions").insert({
      id: sessionId, expires_at: new Date(Date.now() + MAX_SECONDS * 1000).toISOString(),
    });
    if (registered.error) {
      // A paid session without a server expiry record must never reach a phone.
      throw new Error("live_expiry_registration_failed");
    }
    expiryRegistered = true;
    await settleAiSpend(service, reservation, null, MODEL, Math.ceil(((MAX_SECONDS + 60) / 60) * MICROS_PER_MINUTE));
    return jsonResponse({ sdp: answer, maxSeconds: MAX_SECONDS }, 200, cors);
  } catch (error) {
    if (createdSessionId) {
      const key = requireOpenAI();
      let stopped = false;
      for (let attempt = 0; attempt < 2 && !stopped; attempt++) {
        const response = await fetch(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(createdSessionId)}/hangup`, {
          method: "POST", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000),
        }).catch(() => null);
        stopped = !!(response?.ok || response?.status === 404 || response?.status === 409);
        if (!stopped && attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (stopped) {
        await service.from("live_ask_provider_sessions").update({ closed_at: new Date().toISOString() }).eq("id", createdSessionId);
      } else if (!expiryRegistered) {
        // No ledger row exists for the reaper. Keep the opaque provider ID in
        // server logs so an operator can close this exceptional orphan.
        console.error("live_ask_orphan_possible", createdSessionId);
      }
    }
    // Reached the provider: the money comes back, the call count stays (a
    // client stuck retrying must still run out of quota).
    await releaseAiSpend(service, reservation, "live_session_failed", !reached);
    await reportCaughtError("live-ask-session", req, error);
    return jsonResponse({ error: "live_failed" }, 502, cors);
  }
}));

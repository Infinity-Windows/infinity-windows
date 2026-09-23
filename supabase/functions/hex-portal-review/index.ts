import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import { corsHeaders, jsonResponse, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../_shared/openai.ts";
import { reportCaughtError, withSentry } from "../_shared/sentry.ts";
import { readBodyCapped } from "../_shared/bytes.ts";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, RECEIVER_TIMEOUT_MS, parseBridgeRequest, runBridge } from "../_shared/hexReviewBridge.ts";

// Delivers one supervisor-approved lesson to the Hex-Portal archive, or takes a
// withdrawn one back, when a person taps — as that person. The proofs are read
// with their JWT; Hexcore re-reads them with the same JWT. The service role only
// records the receiver's answer through functions that re-check the approval.
// The existing /crew guidance proxy (hex-portal) is separate and unchanged.
Deno.serve(
  withSentry("hex-portal-review", async (req) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, cors);
    const auth = await verifyCaller(req), caller = callerSupabaseClient(req);
    if (auth.status !== "ok" || auth.user.id === "service_role" || !caller) return jsonResponse({ error: "sign_in_required" }, 401, cors);
    try {
      const raw = await readBodyCapped(req, MAX_REQUEST_BYTES);
      if (!raw) return jsonResponse({ error: "request_too_large" }, 413, cors);
      let body: unknown = null;
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* invalid below */ }
      const request = parseBridgeRequest(body);
      if (!request) return jsonResponse({ error: "invalid_request" }, 400, cors);
      // The phone names who tapped; a different signed-in account sends nothing.
      if (request.actorId !== auth.user.id) return jsonResponse({ status: "not_current" }, 403, cors);
      const secret = Deno.env.get("HEX_PORTAL_SITES_TOKEN");
      const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const result = await runBridge({
        callerRpc: (name, args) => caller.rpc(name, args),
        serviceRpc: (name, args) => service.rpc(name, args),
        configured: !!secret,
        post: async (url, payload) => {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "OAI-Sites-Authorization": `Bearer ${secret}`,
              "X-Forge-Authorization": req.headers.get("Authorization")!,
            },
            body: JSON.stringify(payload),
            redirect: "error",
            signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS),
          });
          const bytes = await readBodyCapped(res, MAX_RESPONSE_BYTES);
          return { status: res.status, text: bytes === null ? null : new TextDecoder().decode(bytes) };
        },
      }, request, auth.user.id);
      return jsonResponse(result, 200, cors);
    } catch {
      // A fixed label only: never tokens, lesson text or receiver bodies.
      await reportCaughtError("hex-portal-review", req, new Error("review_bridge_failed"));
      return jsonResponse({ status: "failed" }, 503, cors);
    }
  }),
);

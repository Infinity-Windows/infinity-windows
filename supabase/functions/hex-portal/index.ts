import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
} from "../_shared/openai.ts";
import { reportCaughtError, withSentry } from "../_shared/sentry.ts";
const URL =
  "https://hexcore-observatory.ammonson17.chatgpt.site/api/hex-portal/crew";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
Deno.serve(
  withSentry("hex-portal", async (req) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST")
      return jsonResponse({ error: "method_not_allowed" }, 405, cors);
    const auth = await verifyCaller(req),
      caller = callerSupabaseClient(req);
    if (auth.status !== "ok" || auth.user.id === "service_role" || !caller)
      return jsonResponse({ error: "sign_in_required" }, 401, cors);
    try {
      // Bound the stream, not only Content-Length (which the caller can omit).
      const reader = req.body?.getReader();
      if (!reader) return jsonResponse({ error: "invalid_request" }, 400, cors);
      let text = "",
        bytes = 0;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 10000) {
          await reader.cancel();
          return jsonResponse({ error: "request_too_large" }, 413, cors);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const b = JSON.parse(text);
      if (
        !b ||
        Object.keys(b).some((k) => !["projectId", "question"].includes(k)) ||
        !uuid.test(b.projectId) ||
        typeof b.question !== "string" ||
        !b.question.trim() ||
        b.question.length > 6000
      )
        return jsonResponse({ error: "invalid_request" }, 400, cors);
      const identity = await caller.rpc("hex_portal_identity", {
        p_project_id: b.projectId,
      });
      if (identity.error || identity.data?.userId !== auth.user.id)
        return jsonResponse({ error: "job_access_unavailable" }, 403, cors);
      const secret = Deno.env.get("HEX_PORTAL_SITES_TOKEN");
      if (!secret)
        return jsonResponse(
          { enabled: false, items: [], notice: "pilot_setup_pending" },
          200,
          cors,
        );
      const response = await fetch(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "OAI-Sites-Authorization": `Bearer ${secret}`,
          "X-Forge-Authorization": req.headers.get("Authorization")!,
        },
        body: JSON.stringify(b),
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok)
        return jsonResponse(
          { error: "guidance_temporarily_unavailable" },
          503,
          cors,
        );
      const raw = await response.text();
      if (raw.length > 160000) throw new Error("oversized_guidance");
      const result = JSON.parse(raw);
      if (
        typeof result.enabled !== "boolean" ||
        !Array.isArray(result.items) ||
        result.items.length > 3 ||
        result.items.some(
          (d: Record<string, unknown>) =>
            !uuid.test(String(d.id)) ||
            !Number.isSafeInteger(d.revision) ||
            Number(d.revision) < 1 ||
            typeof d.title !== "string" ||
            typeof d.answer !== "string",
        )
      )
        throw new Error("invalid_guidance");
      // Recheck source permissions after crossing the bridge. Transport authority
      // cannot elevate the crew member. Receipts only attest returned revisions.
      const current = await caller.rpc("hex_portal_identity", {
        p_project_id: b.projectId,
      });
      if (
        current.error ||
        JSON.stringify(current.data) !== JSON.stringify(identity.data)
      )
        return jsonResponse({ error: "access_changed" }, 403, cors);
      if (result.items.length) {
        const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
        const { error } = await service
          .from("hex_portal_guidance_receipts")
          .upsert(
            result.items.map((d: { id: string; revision: number }) => ({
              actor_id: auth.user.id,
              project_id: b.projectId,
              guidance_id: d.id,
              revision: d.revision,
            })),
            {
              onConflict: "actor_id,project_id,guidance_id,revision",
              ignoreDuplicates: true,
            },
          );
        if (error) throw new Error("guidance_receipt_failed");
      }
      return jsonResponse(result, 200, cors);
    } catch {
      // Report only a fixed label; never tokens, crew questions or upstream bodies.
      await reportCaughtError(
        "hex-portal",
        req,
        new Error("guidance_request_failed"),
      );
      return jsonResponse(
        { error: "guidance_temporarily_unavailable" },
        503,
        cors,
      );
    }
  }),
);

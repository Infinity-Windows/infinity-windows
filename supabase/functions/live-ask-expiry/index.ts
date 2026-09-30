import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, jsonResponse, requireOpenAI, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../_shared/openai.ts";
import { reportCaughtError, withSentry } from "../_shared/sentry.ts";

/** Parameterless cron target: only already-expired provider sessions can close. */
Deno.serve(withSentry("live-ask-expiry", async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, cors);
  try {
    const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await service.from("live_ask_provider_sessions")
      .select("id").is("closed_at", null).lte("expires_at", new Date().toISOString())
      .order("expires_at").limit(50);
    if (error) throw error;
    const key = requireOpenAI();
    let closed = 0;
    let failed = 0;
    for (const row of data ?? []) {
      const response = await fetch(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(row.id)}/hangup`, {
        method: "POST", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      // A session already closed by the phone needs no further retries.
      if (response?.ok || response?.status === 404 || response?.status === 409) {
        const marked = await service.from("live_ask_provider_sessions")
          .update({ closed_at: new Date().toISOString() }).eq("id", row.id).is("closed_at", null);
        if (marked.error) throw marked.error;
        closed++;
      } else failed++;
    }
    // Retain one day for operational diagnosis; never store audio here.
    await service.from("live_ask_provider_sessions").delete().lt("closed_at", new Date(Date.now() - 86_400_000).toISOString());
    if (failed) throw new Error("provider_hangup_failed");
    return jsonResponse({ checked: data?.length ?? 0, closed }, 200, cors);
  } catch (error) {
    await reportCaughtError("live-ask-expiry", req, error);
    return jsonResponse({ error: "expiry_unavailable" }, 503, cors);
  }
}));

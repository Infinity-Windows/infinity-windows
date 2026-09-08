// Publication commits an outbox, independently of push availability. This
// manager-triggered worker only delivers committed notices, never arbitrary
// recipients or message text supplied by the browser.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";
import { verifyCaller } from "../_shared/auth.ts";
import { UNEXPECTED_ERROR, reportCaughtError, withSentry } from "../_shared/sentry.ts";

Deno.serve(withSentry("deliver-workflow-notices", async req => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "POST required" }, 405, cors);
  const caller = await verifyCaller(req);
  if (caller.status !== "ok" || caller.user.id === "service_role") return jsonResponse({ error: "Sign in as a supervisor." }, 401, cors);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
    const profile = await admin.from("profiles").select("role,is_partner,active").eq("id", caller.user.id).single();
    if (profile.error || !profile.data?.active || profile.data.is_partner || !["supervisor", "owner", "admin", "big_boss"].includes(profile.data.role)) return jsonResponse({ error: "Only an internal supervisor can deliver plan notices." }, 403, cors);
    const { planId } = await req.json();
    if (typeof planId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(planId)) return jsonResponse({ error: "Choose a connected plan." }, 400, cors);
    const publicKey = Deno.env.get("VAPID_PUBLIC_KEY"); const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    if (!publicKey || !privateKey) return jsonResponse({ error: "Push is not configured. Notices remain queued." }, 503, cors);
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@infinitywindows.app", publicKey, privateKey);
    const lease = crypto.randomUUID();
    const claimed = await admin.rpc("workflow_claim_notices", { p_plan: planId, p_lease: lease });
    if (claimed.error) throw claimed.error;
    const results = await Promise.all((claimed.data ?? []).map(async (notice: { id: string; profile_id: string; revision: number }) => {
      const subscriptions = await admin.from("push_subscriptions").select("endpoint,p256dh,auth").eq("profile_id", notice.profile_id);
      let sent = !subscriptions.error && (subscriptions.data?.length ?? 0) > 0;
      if (sent) {
        const outcomes = await Promise.all((subscriptions.data ?? []).map(async row => {
          if (!row.endpoint || !row.p256dh || !row.auth) return false;
          try {
            await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify({
              title: "Your work plan changed", body: "Open My Schedule to review the latest instructions.",
              url: "/my-schedule", tag: `workflow-${planId}-${notice.revision}-${notice.profile_id}`,
            }), { TTL: 600, timeout: 8000 });
            return true;
          } catch { return false; } // Never log subscription keys or push endpoints.
        }));
        sent = outcomes.every(Boolean);
      }
      const finished = await admin.rpc("workflow_finish_notice", { p_id: notice.id, p_lease: lease, p_sent: sent });
      if (finished.error) throw finished.error; // Lease expiry recovers interrupted workers.
      return sent;
    }));
    return jsonResponse({ sent: results.filter(Boolean).length, failed: results.filter(x => !x).length }, 200, cors);
  } catch (e) {
    await reportCaughtError("deliver-workflow-notices", req, e);
    return jsonResponse({ error: UNEXPECTED_ERROR }, 500, cors);
  }
}));

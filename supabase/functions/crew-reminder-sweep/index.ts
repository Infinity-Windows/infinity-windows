// Parameterless cron target: all recipients, due times and copy come from SQL.
// A caller can only run the already-due sweep. Leases prevent concurrent delivery.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";
import {
  withSentry,
  reportCaughtError,
  UNEXPECTED_ERROR,
} from "../_shared/sentry.ts";
Deno.serve(
  withSentry("crew-reminder-sweep", async (req) => {
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST")
      return jsonResponse({ error: "POST required" }, 405, cors);
    try {
      const pub = Deno.env.get("VAPID_PUBLIC_KEY"),
        priv = Deno.env.get("VAPID_PRIVATE_KEY");
      if (!pub || !priv)
        return jsonResponse(
          { error: "Push is not configured; reminders remain queued." },
          503,
          cors,
        );
      webpush.setVapidDetails(
        Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@infinitywindows.app",
        pub,
        priv,
      );
      const admin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      const lease = crypto.randomUUID();
      const claimed = await admin.rpc("claim_crew_reminders", {
        p_lease: lease,
      });
      if (claimed.error) throw claimed.error;
      let sentCount = 0;
      for (const row of claimed.data ?? []) {
        const subs = await admin
          .from("push_subscriptions")
          .select("endpoint,p256dh,auth")
          .eq("profile_id", row.profile_id);
        let sent = false;
        if (!subs.error) {
          const results = await Promise.all(
            (subs.data ?? []).map(async (sub) => {
              try {
                await webpush.sendNotification(
                  {
                    endpoint: sub.endpoint,
                    keys: { p256dh: sub.p256dh, auth: sub.auth },
                  },
                  JSON.stringify({
                    title: row.title,
                    body: row.body,
                    url: row.url,
                    tag: row.dedupe_key,
                  }),
                  { TTL: row.shift_id ? 60 : 3600, timeout: 8000 },
                );
                return true;
              } catch {
                return false;
              }
            }),
          );
          sent = results.some(Boolean);
        }
        const done = await admin.rpc("finish_crew_reminder", {
          p_id: row.id,
          p_lease: lease,
          p_sent: sent,
        });
        if (done.error) throw done.error;
        if (sent) sentCount++;
      }
      return jsonResponse(
        { claimed: claimed.data?.length ?? 0, sent: sentCount },
        200,
        cors,
      );
    } catch (e) {
      await reportCaughtError("crew-reminder-sweep", req, e);
      return jsonResponse({ error: UNEXPECTED_ERROR }, 500, cors);
    }
  }),
);

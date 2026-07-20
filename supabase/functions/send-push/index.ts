// send-push (p1-10 follow-up): deliver a web push to a user's devices so an
// alert lands even when the app is fully closed. Renders through the SAME
// { title, body, tag, url } shape as the LOCAL path (notifyLocal.ts) — the
// service worker's `push` handler calls showNotification with these fields, so
// pushed and local notifications look identical.
//
// Auth: the platform gate (verify_jwt = true) + requireCaller() ensure only a
// signed-in user or a service-role caller can invoke this. The function then
// uses the SERVICE ROLE key internally to read every matching subscription
// (RLS would otherwise hide other users' rows).
//
// Secrets (all from Deno.env, never hardcoded):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";
import { requireCaller } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@infinitywindows.app";

interface SendPushBody {
  profileIds?: string[];
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
}

/** A push endpoint is gone (prune it) when it returns 404 or 410. Mirrors the
 * client-side pushCore.isGoneStatus contract. */
function isGoneStatus(status: number): boolean {
  return status === 404 || status === 410;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const unauthorized = await requireCaller(req, cors);
  if (unauthorized) return unauthorized;

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return jsonResponse({ error: "VAPID keys not configured" }, 500, cors);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Supabase service role not configured" }, 500, cors);
  }

  try {
    const payload = (await req.json()) as SendPushBody;
    const title = (payload.title ?? "").trim();
    if (!title) {
      return jsonResponse({ error: "title required" }, 400, cors);
    }

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Broadcast when no profileIds are given; otherwise target those users.
    let query = admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth");
    if (Array.isArray(payload.profileIds) && payload.profileIds.length > 0) {
      query = query.in("profile_id", payload.profileIds);
    }
    const { data, error } = await query;
    if (error) {
      return jsonResponse({ error: error.message }, 500, cors);
    }

    const subs = (data ?? []) as SubscriptionRow[];
    const notificationJson = JSON.stringify({
      title,
      body: payload.body ?? "",
      tag: payload.tag,
      url: payload.url,
    });

    let sent = 0;
    const goneEndpoints: string[] = [];

    await Promise.all(
      subs.map(async (row) => {
        if (!row.endpoint || !row.p256dh || !row.auth) return;
        const subscription = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        try {
          await webpush.sendNotification(subscription, notificationJson);
          sent += 1;
        } catch (err) {
          const status = Number(
            (err as { statusCode?: number }).statusCode ?? 0,
          );
          if (isGoneStatus(status)) goneEndpoints.push(row.endpoint);
          // Other failures (e.g. transient 5xx) are ignored — best-effort.
        }
      }),
    );

    // Prune dead endpoints so we stop trying to reach uninstalled devices.
    if (goneEndpoints.length > 0) {
      await admin
        .from("push_subscriptions")
        .delete()
        .in("endpoint", goneEndpoints);
    }

    return jsonResponse(
      { sent, pruned: goneEndpoints.length, total: subs.length },
      200,
      cors,
    );
  } catch (e) {
    console.error("send-push failed", e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

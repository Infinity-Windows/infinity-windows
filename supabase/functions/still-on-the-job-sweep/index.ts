// still-on-the-job-sweep (Wave K, K2 — transcripts grill, 2026-09-03, Q6b):
// the evening "are you really still on the job?" nudge. A phone with the app
// closed cannot remind itself, so a pg_cron job pokes this every five minutes
// (see migration 20260976000000) and it pushes the people who are still on the
// clock once the company's local nudge hour has passed.
//
// Auth: verify_jwt = false ON PURPOSE, and safe for the same reason
// summon-warning-sweep is: the function is parameterless and idempotent — it
// accepts NO input, decides everything in the database, and claims each person
// exactly once per local day inside a single UPDATE ... RETURNING. An
// unauthenticated caller can only make it look for people who are due, which
// the cron does anyway.
//
// EVERY decision lives in claim_still_on_the_job_nudges(): the nudge hour (a
// foreman-adjustable company setting), the Travel-900 exclusion, the "already
// clocked in before the hour" rule, and the once-per-day claim. This file does
// the one thing SQL cannot — send a web push — and nothing else. Keeping the
// judgement in SQL is what makes the claim atomic; two overlapping sweeps
// cannot both push the same person.
//
// Secrets (Deno.env, never hardcoded): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@infinitywindows.app";

interface ClaimedNudge {
  shift_id: string;
  profile_id: string;
  project_id: string | null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "service role not configured" }, 500, cors);
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return jsonResponse({ error: "VAPID keys not configured" }, 500, cors);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The claim IS the decision. Before the nudge hour this returns nobody, which
  // is what it does for most of the day.
  const { data, error } = await admin.rpc("claim_still_on_the_job_nudges");
  if (error) {
    // A database that has not applied the migration yet is not an outage —
    // the sweep simply has nothing to do until it has.
    return jsonResponse({ claimed: 0, error: error.message }, 200, cors);
  }
  const claimed = (data ?? []) as ClaimedNudge[];
  if (claimed.length === 0) return jsonResponse({ claimed: 0, pushed: 0 }, 200, cors);

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  // Push copy stays English by design (the program's own rule): a push is
  // rendered by the operating system long before the app's language layer
  // gets a say in it.
  let pushed = 0;
  for (const row of claimed) {
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("profile_id", row.profile_id);
    const payload = JSON.stringify({
      title: "Still on the job?",
      body: "Tap to switch to Travel or clock out.",
      tag: `still-on-job-${row.shift_id}`,
      url: "/clock",
    });
    await Promise.all(
      (subs ?? []).map(async (sub) => {
        if (!sub.endpoint || !sub.p256dh || !sub.auth) return;
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 3600 },
          );
        } catch {
          // A dead endpoint is pruned by send-push's normal traffic; the
          // sweep just moves on rather than failing the whole evening.
        }
      }),
    );
    pushed += 1;
  }

  return jsonResponse({ claimed: claimed.length, pushed }, 200, cors);
});

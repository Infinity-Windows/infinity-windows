// summon-warning-sweep (owner ask, 2026-08-19): the 5-minute warning for
// summon answerers. A phone with the app closed cannot remind itself, so a
// pg_cron job pokes this once a minute (see migration 20260918000000).
//
// Auth: verify_jwt = false ON PURPOSE, and that is safe because the function
// is parameterless and idempotent — it accepts NO input, decides everything
// from the database with its own service-role client, and marks each helper
// warned exactly once (warned_at). An unauthenticated caller can only make
// it look for due warnings, which the cron does every minute anyway.
//
// What is "due": a live summon (open/covered) with a needed_at inside the
// next 5 minutes. Every helper on it who hasn't completed and hasn't been
// warned gets one urgent push, then wears warned_at. Helpers who answer
// INSIDE the final 5 minutes are not warned — they just read the time.
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

interface DueHelper {
  helperId: string;
  profileId: string;
  projectId: string;
  openingId: string;
  openingCode: string;
  neededAt: string;
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

  // Live summons due inside 5 minutes, with their unwarned, uncompleted
  // helpers. Two cheap queries beat one clever join on a table this small.
  const nowIso = new Date().toISOString();
  const dueIso = new Date(Date.now() + 5 * 60_000).toISOString();
  const { data: summons, error: sErr } = await admin
    .from("summons")
    .select("id, project_id, opening_id, needed_at")
    .in("status", ["open", "covered"])
    .not("needed_at", "is", null)
    .gte("needed_at", nowIso)
    .lte("needed_at", dueIso);
  if (sErr) return jsonResponse({ error: sErr.message }, 500, cors);
  if (!summons || summons.length === 0) {
    return jsonResponse({ due: 0, warned: 0 }, 200, cors);
  }

  const { data: helpers, error: hErr } = await admin
    .from("summon_helpers")
    .select("id, summon_id, profile_id")
    .in("summon_id", summons.map((s) => s.id))
    .is("warned_at", null)
    .is("completed_at", null);
  if (hErr) return jsonResponse({ error: hErr.message }, 500, cors);

  const { data: openings } = await admin
    .from("project_openings")
    .select("id, opening_code")
    .in("id", summons.map((s) => s.opening_id));
  const codeById = new Map((openings ?? []).map((o) => [o.id, o.opening_code]));
  const summonById = new Map(summons.map((s) => [s.id, s]));

  const due: DueHelper[] = (helpers ?? []).map((h) => {
    const s = summonById.get(h.summon_id)!;
    return {
      helperId: h.id,
      profileId: h.profile_id,
      projectId: s.project_id,
      openingId: s.opening_id,
      openingCode: codeById.get(s.opening_id) ?? "the unit",
      neededAt: s.needed_at,
    };
  });
  if (due.length === 0) return jsonResponse({ due: 0, warned: 0 }, 200, cors);

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  let warned = 0;
  for (const d of due) {
    // Mark FIRST — if the send half-fails we under-warn once rather than
    // ring the same phone every minute until the deadline.
    const { error: markErr } = await admin
      .from("summon_helpers")
      .update({ warned_at: new Date().toISOString() })
      .eq("id", d.helperId)
      .is("warned_at", null);
    if (markErr) continue;

    const when = new Date(d.neededAt).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth")
      .eq("profile_id", d.profileId);
    const payload = JSON.stringify({
      title: "⏰ 5 minutes — heavy lift",
      body: `Be at ${d.openingCode} by ${when} — you answered this summon.`,
      tag: `summon-warn-${d.helperId}`,
      url: `/projects/${d.projectId}/opening/${d.openingId}`,
      urgent: true,
    });
    await Promise.all(
      (subs ?? []).map(async (row) => {
        if (!row.endpoint || !row.p256dh || !row.auth) return;
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            payload,
            { headers: { Urgency: "high" }, TTL: 300 },
          );
        } catch {
          // A dead endpoint is pruned by send-push's normal traffic; the
          // sweep just moves on.
        }
      }),
    );
    warned += 1;
  }

  return jsonResponse({ due: due.length, warned }, 200, cors);
});

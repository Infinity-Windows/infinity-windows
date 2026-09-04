// pipeline-sweep (Wave J, J4 — transcripts grill, 2026-09-03, Q9): the 7 AM
// "this job is not going to be ready" push. A phone with the app closed cannot
// notice that Sand Hollow starts in seven days and still has no windows, so a
// pg_cron job pokes this hourly (see migration 20260979000000) and it pushes
// the people who can do something about it, once, on the morning it matters.
//
// Auth: verify_jwt = false ON PURPOSE, and safe for the same reason
// summon-warning-sweep and still-on-the-job-sweep are: the function is
// parameterless and idempotent — it accepts NO input, decides everything in the
// database, and claims each warning exactly once inside a single
// insert ... on conflict do nothing ... returning. An unauthenticated caller
// can only make it look for warnings that are due, which the cron does anyway.
//
// EVERY decision lives in claim_pipeline_nudges(): the 7 AM company-local gate,
// the 14- and 7-day windows, the missed-ETA rule, who hears it, and the
// once-per-thing claim. This file does the one thing SQL cannot — send a web
// push — and nothing else. Keeping the judgement in SQL is what makes the claim
// atomic; two overlapping sweeps cannot both push the same sentence.
//
// J5 — THE EXTENSION POINT. `RULES` below is a list, not a single call, for
// exactly one reason: wave O's credential-expiry warnings are meant to arrive
// as one more claim function (claim_credential_nudges) writing its own kinds
// into the same pipeline_nudges ledger, and one more entry here — never as a
// second cron job and a second edge function that push at almost the same
// minute. A rule contributes an RPC name and a way to word its push; the
// claiming, the audience and the sending are already done for it. A rule whose
// RPC does not exist yet (a database ahead of or behind this deploy) is skipped
// with a note rather than failing the sweep.
//
// Push copy stays English by design (the program's own rule): a push is
// rendered by the operating system long before the app's language layer gets a
// say in it.
//
// Secrets (Deno.env, never hardcoded): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT. No new secret — the VAPID pair is the same one send-push and
// the other two sweeps already run on.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@infinitywindows.app";

/** One claimed warning, exactly as claim_pipeline_nudges() returns it. */
interface ClaimedNudge {
  project_id: string;
  job_label: string;
  kind: string;
  days_until: number | null;
  not_ready: boolean;
  materials_missing: boolean;
  profile_ids: string[] | null;
}

interface PushCopy {
  title: string;
  body: string;
}

/**
 * A rule the sweep runs: the claim RPC to call, and how to word what it
 * claimed. Wave O adds a second entry here; nothing else about this file
 * changes.
 */
interface SweepRule {
  name: string;
  rpc: string;
  copy: (row: ClaimedNudge) => PushCopy;
}

/**
 * "Sand Hollow starts in 7 days — still Not ready · windows not in".
 *
 * The reasons are joined with the same "·" the job cards use, and only the
 * true ones appear: a job that is Ready but has no windows reads "windows not
 * in" and nothing else, because telling somebody a job is not ready when it is
 * ready is how a warning stops being read.
 */
function pipelineCopy(row: ClaimedNudge): PushCopy {
  const reasons: string[] = [];
  if (row.not_ready) reasons.push("still Not ready");
  if (row.materials_missing) reasons.push("windows not in");
  const tail = reasons.length > 0 ? ` — ${reasons.join(" · ")}` : "";

  if (row.kind === "materials_late") {
    return {
      title: `${row.job_label}: windows are late`,
      body: "The day they were due has passed and nobody has marked them arrived.",
    };
  }

  const days = row.days_until ?? 0;
  const when =
    days <= 0 ? "starts today" : days === 1 ? "starts tomorrow" : `starts in ${days} days`;
  return { title: `${row.job_label} ${when}`, body: `${row.job_label} ${when}${tail}.` };
}

const RULES: SweepRule[] = [
  { name: "job pipeline", rpc: "claim_pipeline_nudges", copy: pipelineCopy },
  // Wave O (O4) adds:
  //   { name: "credentials", rpc: "claim_credential_nudges", copy: credentialCopy },
];

/** Send one push to everybody named, ignoring endpoints that have gone dead. */
async function pushAll(
  admin: SupabaseClient,
  profileIds: string[],
  payload: string,
): Promise<number> {
  if (profileIds.length === 0) return 0;
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("profile_id", profileIds);
  let sent = 0;
  await Promise.all(
    (subs ?? []).map(async (sub) => {
      if (!sub.endpoint || !sub.p256dh || !sub.auth) return;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 6 * 3600 },
        );
        sent += 1;
      } catch {
        // A dead endpoint is pruned by send-push's normal traffic; the sweep
        // moves on rather than failing the whole morning over one phone.
      }
    }),
  );
  return sent;
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

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  let claimed = 0;
  let pushed = 0;
  const skipped: string[] = [];

  for (const rule of RULES) {
    // The claim IS the decision. Before 7 AM company time this returns nobody,
    // which is what it does for most of the day.
    const { data, error } = await admin.rpc(rule.rpc);
    if (error) {
      // A database that has not applied the migration yet is not an outage —
      // the sweep simply has nothing to do until it has.
      skipped.push(`${rule.name}: ${error.message}`);
      continue;
    }
    const rows = (data ?? []) as ClaimedNudge[];
    claimed += rows.length;
    for (const row of rows) {
      const { title, body } = rule.copy(row);
      const payload = JSON.stringify({
        title,
        body,
        // One tag per job per kind, so a second morning's warning replaces the
        // first on the lock screen instead of stacking up.
        tag: `pipeline-${row.kind}-${row.project_id}`,
        url: `/projects/${row.project_id}`,
      });
      pushed += await pushAll(admin, row.profile_ids ?? [], payload);
    }
  }

  return jsonResponse({ claimed, pushed, skipped }, 200, cors);
});

// gc-link (Wave H, H2 — transcripts grill, 2026-09-03, Q11): the whole of what
// a general contractor can do with a link we sent him, and nothing else.
//
// THE ONE THING TO UNDERSTAND ABOUT THIS FILE: a token is a key to THIS
// FUNCTION, never to a table. Migration 20260981000000 adds no anon policy to
// anything, and the three RPCs below are granted to service_role alone — so a
// crew login holding a token cannot call them from a browser, and a stranger
// holding one can reach exactly the four things this file chooses to answer
// with. Everything outward is built FIELD BY FIELD (wave S's projection law):
// there is no row spread into a response anywhere here, because a spread is how
// a column added next year leaks to a customer with nobody noticing.
//
// WHAT THE GC SEES: the job's name, which of our two brands to expect, the six
// questions with whatever was last answered, and the thread. WHAT HE NEVER
// SEES: our readiness, our materials dates, our schedule, our crew, our costs,
// or anything about any other job. That is why wave H's first commit moved
// readiness off `projects` — an outward door is only as good as what is behind
// it.
//
// Auth: verify_jwt = true, the same shape as redeem-crew-invite and for the
// same reason. The Supabase gateway accepts the project's anon key as a valid
// JWT, so the app's own supabase-js client reaches this code with no user
// signed in, while an unauthenticated request with no Authorization header at
// all is refused by the gateway before this file runs. The real credential is
// the token, checked here.
//
// Brute force: 32 random bytes is 256 bits. There is nothing to grind. Writes
// are still rate-limited in _gc_link_for_write — not against a stranger, but
// so a stuck retry loop on a builder's phone cannot fill a table.
//
// Secrets (Deno.env, never hardcoded): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// VAPID_SUBJECT. No new secret — the VAPID pair is the one send-push and the
// sweeps already run on.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";
import { hashGcToken, looksLikeGcToken } from "../_shared/gcToken.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@infinitywindows.app";

/** The one sentence a GC ever reads about a link that will not work. It does
 * not distinguish expired from revoked from never-existed, on purpose: the
 * person holding it needs the same next step either way, and a stranger
 * probing learns nothing from the shape of the answer. */
const DEAD_LINK = "This link has expired — ask your installer for a new one.";

interface LinkRow {
  link_id: string;
  project_id: string;
  job_label: string;
  brand: string;
  state: string;
}

/** The GC's own view of one prior answer — six fields and a date, and not one
 * column more than that. Built by hand from the row; never spread. */
function answersOut(row: Record<string, unknown> | null) {
  if (!row) return null;
  return {
    answeredAt: String(row.contacted_at ?? ""),
    expectedEndDate: (row.expected_end_date as string | null) ?? null,
    roofOnDate: (row.roof_on_date as string | null) ?? null,
    framingChecked: (row.framing_checked as boolean | null) ?? null,
    setPreference: (row.set_preference as string | null) ?? null,
    exteriorMaterial: (row.exterior_material as string | null) ?? null,
    interiorMaterial: (row.interior_material as string | null) ?? null,
    /** Who the office recorded, or the name the GC typed himself. */
    contactName: (row.contact_name as string | null) ?? null,
  };
}

/** One line of the thread, as the GC sees it. The office's replies are "us";
 * WHICH of us is deliberately dropped — a builder does not need the roster,
 * and a name here would be a crew fact travelling outward. */
function messageOut(row: Record<string, unknown>) {
  return {
    id: String(row.id ?? ""),
    from: row.author === "gc" ? "you" : "us",
    body: String(row.body ?? ""),
    at: String(row.created_at ?? ""),
  };
}

async function loadLink(admin: SupabaseClient, tokenHash: string): Promise<LinkRow | null> {
  const { data, error } = await admin.rpc("gc_link_open", { p_token_hash: tokenHash });
  if (error) return null;
  const rows = (data ?? []) as LinkRow[];
  return rows[0] ?? null;
}

/** Push everybody the RPC named. A dead endpoint is skipped, never fatal — the
 * GC's answer is already filed by the time this runs, and losing a
 * notification must not turn a successful answer into an error on his screen. */
async function pushAll(
  admin: SupabaseClient,
  profileIds: string[],
  title: string,
  body: string,
  projectId: string,
): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || profileIds.length === 0) return;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .in("profile_id", profileIds);
  // Push copy stays English by design (the program's own rule): a notification
  // is rendered by the operating system long before the app's language layer
  // gets a say in it.
  const payload = JSON.stringify({
    title,
    body,
    tag: `gc-${projectId}`,
    url: `/projects/${projectId}`,
  });
  await Promise.all(
    (subs ?? []).map(async (sub) => {
      if (!sub.endpoint || !sub.p256dh || !sub.auth) return;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 6 * 3600 },
        );
      } catch {
        // Pruned by send-push's normal traffic; not this function's problem.
      }
    }),
  );
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "service role not configured" }, 500, cors);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: DEAD_LINK }, 400, cors);
  }

  const token = body.token;
  // Shape first, hash second: a refusal is cheaper than a hash, and an endpoint
  // a stranger can reach should do the least possible for a request that was
  // never going to be valid.
  if (!looksLikeGcToken(token)) return jsonResponse({ error: DEAD_LINK }, 404, cors);
  const tokenHash = await hashGcToken(token);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const link = await loadLink(admin, tokenHash);
  if (!link) return jsonResponse({ error: DEAD_LINK }, 404, cors);
  if (link.state !== "live") return jsonResponse({ error: DEAD_LINK, expired: true }, 410, cors);

  const action = typeof body.action === "string" ? body.action : "open";

  // ---- open: the questions, the last answers, and the thread ---------------
  if (action === "open") {
    const { data: last } = await admin
      .from("project_gc_checkins")
      .select(
        "contacted_at, contact_name, expected_end_date, roof_on_date, framing_checked, " +
          "set_preference, exterior_material, interior_material",
      )
      .eq("project_id", link.project_id)
      .order("contacted_at", { ascending: false })
      .limit(1);

    const { data: thread } = await admin
      .from("gc_messages")
      .select("id, author, body, created_at")
      .eq("project_id", link.project_id)
      .order("created_at", { ascending: true })
      .limit(200);

    return jsonResponse(
      {
        job: link.job_label,
        brand: link.brand,
        answers: answersOut((last ?? [])[0] ?? null),
        thread: (thread ?? []).map(messageOut),
      },
      200,
      cors,
    );
  }

  // ---- answer: the six questions ------------------------------------------
  if (action === "answer") {
    const { data, error } = await admin.rpc("gc_link_answer", {
      p_token_hash: tokenHash,
      p_expected_end_date: body.expectedEndDate ?? null,
      p_roof_on_date: body.roofOnDate ?? null,
      p_framing_checked: body.framingChecked ?? null,
      p_set_preference: body.setPreference ?? null,
      p_exterior_material: body.exteriorMaterial ?? null,
      p_interior_material: body.interiorMaterial ?? null,
      p_contact_name: body.contactName ?? null,
      p_notes: body.notes ?? null,
    });
    // The RPC's own sentences are written for the GC to read — "Please say when
    // the roof goes on" — so they go straight through rather than being
    // replaced by something vaguer.
    if (error) return jsonResponse({ error: error.message }, 400, cors);

    const row = ((data ?? []) as { job_label: string; profile_ids: string[] | null }[])[0];
    const who = typeof body.contactName === "string" && body.contactName.trim()
      ? body.contactName.trim()
      : "The GC";
    await pushAll(
      admin,
      row?.profile_ids ?? [],
      `${who} answered for ${row?.job_label ?? "a job"}`,
      "The six questions came back on the GC link.",
      link.project_id,
    );
    return jsonResponse({ ok: true }, 200, cors);
  }

  // ---- say: a message on the thread ---------------------------------------
  if (action === "say") {
    const { data, error } = await admin.rpc("gc_link_say", {
      p_token_hash: tokenHash,
      p_body: body.message ?? "",
    });
    if (error) return jsonResponse({ error: error.message }, 400, cors);

    const row = ((data ?? []) as { job_label: string; profile_ids: string[] | null }[])[0];
    await pushAll(
      admin,
      row?.profile_ids ?? [],
      `A message about ${row?.job_label ?? "a job"}`,
      "The GC wrote on the link you sent him.",
      link.project_id,
    );
    return jsonResponse({ ok: true }, 200, cors);
  }

  return jsonResponse({ error: DEAD_LINK }, 400, cors);
});

// send-email (Wave H, H2 — transcripts grill, 2026-09-03, Q11): the one thing
// in this repo that sends mail, and it sends exactly one kind of message.
//
// IT IS NOT A RELAY, and every rule below exists to keep it from becoming one:
//
//   * The caller must be a FOREMAN OR ABOVE, checked as the caller (their own
//     JWT, my_role_rank through their client) rather than on the service role —
//     the permission mirror this repo already uses for the AI's scheduling
//     tools.
//   * The caller must be able to READ THE JOB the link belongs to. Their own
//     client asks for the row; RLS answers. A foreman who cannot see the job
//     cannot mail its builder.
//   * The recipient is the address STORED ON THE LINK. The request cannot name
//     one. There is no "to" field to abuse.
//   * The body is written here, from the job's name and brand. The request
//     supplies no HTML, no subject and no arbitrary URL — only the token, which
//     is checked against the link's own hash before anything is sent.
//   * The link's origin is checked against a short allow-list of places this
//     app is actually served from, so the mail cannot be made to point a
//     customer at somebody else's site.
//
// RESEND_API_KEY IS OPTIONAL, on purpose (the truthiness-guard form
// scripts/function_secrets.py reads as optional, the same shape monday-sync
// uses for MONDAY_API_TOKEN). Until the owner sets it, this function answers
// "email is not configured" and the GC card says so in plain English and offers
// the link to copy instead — and the deploy's secret gate never fails on a key
// nobody has added yet. A Resend account already exists; password resets were
// routed through it on 2026-09-01. This wave needs an API key of its own.
//
// THE SENDER FOLLOWS THE JOB'S BRAND, and its address is configuration rather
// than code. STG-branded jobs mail from one mailbox and Forge-branded jobs from
// another, because the From line is the half a phone shows before anybody opens
// the message — and the owner can move either mailbox without anybody editing
// this repo. Three optional settings, tried in this order:
//
//     EMAIL_FROM_STG   ─┐
//     EMAIL_FROM_FORGE ─┴─► EMAIL_FROM ─► office@forgewd.com
//
// All three are optional in the same truthiness-guard form RESEND_API_KEY uses,
// so a deploy never fails over an address nobody has set yet. The rule itself
// lives in ../_shared/emailSender.ts, where vitest can test it. Each address
// has to be on a domain verified in Resend or Resend refuses the send — which
// is the failure the UI reports verbatim rather than swallowing.
//
// The email is ENGLISH ONLY in v1, by decision: it goes to a customer who has
// never opened this app and never picked a language in it. Spanish here is a
// translation of the GC page and the mail together, not a catalog entry.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import { hashGcToken, looksLikeGcToken } from "../_shared/gcToken.ts";
import {
  BRAND_NAMES,
  brandKey,
  resolveSender,
  type SenderSettings,
} from "../_shared/emailSender.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/**
 * The three sender addresses, feature-detected one at a time in the
 * truthiness-guard form scripts/function_secrets.py reads as OPTIONAL (the same
 * shape monday-sync uses for MONDAY_API_TOKEN, and RESEND_API_KEY uses below).
 *
 * Read here rather than bound to module constants on purpose: a constant with a
 * `?? ""` fallback is the exact shape the census counts as REQUIRED, and a
 * required sender address would turn the deploy red over configuration nobody
 * has to provide.
 */
function senderSettings(): SenderSettings {
  const settings: SenderSettings = {};
  if (Deno.env.get("EMAIL_FROM_STG")) settings.stg = Deno.env.get("EMAIL_FROM_STG") ?? "";
  if (Deno.env.get("EMAIL_FROM_FORGE")) settings.forge = Deno.env.get("EMAIL_FROM_FORGE") ?? "";
  if (Deno.env.get("EMAIL_FROM")) settings.both = Deno.env.get("EMAIL_FROM") ?? "";
  return settings;
}

/**
 * Where this app is actually served from. The page hands over the origin its
 * own browser is on so the link works from GitHub Pages today and from the
 * custom domain after the cutover; anything else falls back to the canonical
 * address rather than being sent as given. Without this the request could aim a
 * customer at any site at all, which is precisely the "not a relay" rule.
 */
const ALLOWED_ORIGINS = [
  "https://app.forgewd.com",
  "https://forgewd.com",
  "https://infinity-windows.github.io",
];
const DEFAULT_LINK_BASE = "https://app.forgewd.com/";

function linkUrl(appBase: unknown, token: string): string {
  const base = typeof appBase === "string" ? appBase : "";
  try {
    const url = new URL(base);
    if (!ALLOWED_ORIGINS.includes(url.origin)) return `${DEFAULT_LINK_BASE}gc/${token}`;
    const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    return `${url.origin}${path}gc/${token}`;
  } catch {
    return `${DEFAULT_LINK_BASE}gc/${token}`;
  }
}

/** Plain text, because a builder reads this on a phone in a truck and half of
 * them have images off. One paragraph, one link, one instruction. */
function emailBody(job: string, brand: string, url: string): { subject: string; text: string } {
  const company = BRAND_NAMES[brandKey(brand)];
  return {
    subject: `${company}: six quick questions about ${job}`,
    text: [
      `Hi,`,
      ``,
      `We are getting ready for the windows and doors at ${job}, and there are six`,
      `things we need from you: when you expect the house to be finished, when the`,
      `roof goes on, whether the framing has been checked, whether you want the`,
      `windows inset or outset, and what is going on the outside and the inside.`,
      ``,
      `Please answer them here — it takes a minute and needs no password:`,
      ``,
      url,
      ``,
      `Please answer on that page rather than replying to this email, so your`,
      `answers reach the crew on the job instead of one inbox. You can also ask us`,
      `a question on the same page, and we will answer you there.`,
      ``,
      `The link works for 30 days.`,
      ``,
      `— ${company}`,
    ].join("\n"),
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "service role not configured" }, 500, cors);
  }

  // Feature-detect the key (the guard form scripts/function_secrets.py reads as
  // OPTIONAL): until the owner sets RESEND_API_KEY this reports itself
  // unconfigured instead of failing the deploy secret gate.
  let resendKey = "";
  if (Deno.env.get("RESEND_API_KEY")) {
    resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  } else {
    return jsonResponse(
      { ok: false, error: "email is not configured", unconfigured: true },
      200,
      cors,
    );
  }

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") return jsonResponse({ error: "unauthorized" }, 401, cors);
  const caller = callerSupabaseClient(req);
  if (!caller) return jsonResponse({ error: "unauthorized" }, 401, cors);

  // Rank checked AS THE CALLER — my_role_rank() reads auth.uid(), which on the
  // service role would be nobody at all. This is the same permission mirror the
  // scheduling tools use.
  const { data: rank } = await caller.rpc("my_role_rank");
  if (typeof rank !== "number" || rank < 1) {
    return jsonResponse({ error: "Only a foreman or above can email a job's GC." }, 403, cors);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "Nothing to send." }, 400, cors);
  }

  const linkId = typeof body.linkId === "string" ? body.linkId : "";
  const token = body.token;
  if (!linkId || !looksLikeGcToken(token)) {
    return jsonResponse({ error: "That link is not one of ours." }, 400, cors);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: link } = await admin
    .from("gc_links")
    .select("id, project_id, sent_to_email, token_hash, expires_at, revoked_at")
    .eq("id", linkId)
    .maybeSingle();
  if (!link) return jsonResponse({ error: "That link is not one of ours." }, 404, cors);

  // The token has to match the link it claims to be. Without this check the
  // request could name a real link id and any string, and we would mail a
  // customer a URL that opens nothing.
  if ((await hashGcToken(token)) !== link.token_hash) {
    return jsonResponse({ error: "That link is not one of ours." }, 400, cors);
  }
  if (link.revoked_at || new Date(link.expires_at).getTime() <= Date.now()) {
    return jsonResponse({ error: "That link has been turned off. Make a new one." }, 400, cors);
  }
  if (!link.sent_to_email) {
    return jsonResponse({ error: "This link has no email address on it." }, 400, cors);
  }

  // Can this caller actually see the job? Their own client, their own RLS. A
  // foreman who cannot read the job cannot mail its builder. gc_brand rides
  // along on the same read because the JOB owns the brand, not the link: the
  // subject line has to say the name the office is using with this builder
  // now, even when the link being resent was minted under the other one.
  const { data: project } = await caller
    .from("projects")
    .select("id, name, job_code, gc_brand")
    .eq("id", link.project_id)
    .maybeSingle();
  if (!project) {
    return jsonResponse({ error: "You do not have that job." }, 403, cors);
  }

  const jobLabel = String(project.name || project.job_code || "your job");
  const brand = String(project.gc_brand ?? "stg");

  // Who it comes FROM follows the same brand the subject and signature do. A
  // setting that is not an address is refused here, by name, rather than sent:
  // Resend would refuse it too, but "check EMAIL_FROM_STG" is worth more to the
  // foreman holding the phone than a 422 from an API he has never heard of.
  const sender = resolveSender(brand, senderSettings());
  if (!sender.ok) {
    return jsonResponse(
      {
        error:
          "The address this brand's email comes from is not a real address, so nothing was " +
          `sent. Copy the link and text it, and ask the office to fix ${sender.source}.`,
      },
      500,
      cors,
    );
  }

  const { subject, text } = emailBody(
    jobLabel,
    brand,
    linkUrl(body.appBase, token),
  );

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: sender.header,
      to: [link.sent_to_email],
      subject,
      text,
    }),
  });

  if (!res.ok) {
    // Resend's own words. A verified-domain problem reads as "The gmail.com
    // domain is not verified", which is exactly what the person pressing the
    // button needs to hear — swallowing it would leave them pressing again.
    const detail = await res.text();
    return jsonResponse({ error: `Email did not go: ${detail.slice(0, 300)}` }, 502, cors);
  }

  // Stamp the send on the link, so the card can say when it went and to whom.
  // THIS IS THE ONLY WRITER OF sent_at, and it runs only after a 2xx from
  // Resend — create_gc_link deliberately leaves it null, so "sent" on the card
  // means a mail server accepted it rather than "somebody typed an address".
  // brand is written here too, and only here after mint: the column is the
  // record of the name this email actually wore, which is a real question
  // months later and cannot be edited into the mail after the fact.
  await admin
    .from("gc_links")
    .update({ sent_at: new Date().toISOString(), brand })
    .eq("id", link.id);

  // `from` goes back so the card can say which of the company's two mailboxes
  // this builder just heard from — the question the office asks first when a
  // builder says he never got anything.
  return jsonResponse({ ok: true, to: link.sent_to_email, from: sender.address }, 200, cors);
});

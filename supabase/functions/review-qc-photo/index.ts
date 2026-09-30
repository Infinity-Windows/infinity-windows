/**
 * Optional second look at ONE already-saved install photo. The model cannot
 * pass an opening, create a callback, or write any QC data. The foreman sees
 * the source photo and decides through Qc.tsx's existing human workflow.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import { bytesToBase64 } from "../_shared/bytes.ts";
import { corsHeaders, jsonResponse, requireOpenAI, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "../_shared/openai.ts";
import { notifyOwnersOfSpend, releaseAiSpend, reserveAiSpend, settleAiSpend } from "../_shared/spendGuard.ts";
import { reportCaughtError, withSentry } from "../_shared/sentry.ts";

const MODEL = "gpt-6.1-sol";
const MAX_IMAGE_BYTES = 8_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    visible_checks: { type: "array", items: { type: "string" } },
    questions_for_foreman: { type: "array", items: { type: "string" } },
    limitation: { type: "string" },
  },
  required: ["summary", "visible_checks", "questions_for_foreman", "limitation"],
};

Deno.serve(withSentry("review-qc-photo", async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, cors);
  const auth = await verifyCaller(req);
  if (auth.status !== "ok" || auth.user.id === "service_role") {
    return jsonResponse({ error: "sign_in_required" }, 401, cors);
  }
  const caller = callerSupabaseClient(req);
  if (!caller) return jsonResponse({ error: "sign_in_required" }, 401, cors);
  const { data: profile, error: profileError } = await caller.from("profiles")
    .select("id, retired_at, access_revoked_at").eq("id", auth.user.id).maybeSingle();
  if (profileError || !profile || profile.retired_at || profile.access_revoked_at) {
    return jsonResponse({ error: "access_unavailable" }, 403, cors);
  }
  const { data: rank, error: rankError } = await caller.rpc("my_role_rank");
  if (rankError || typeof rank !== "number" || rank < 1) {
    return jsonResponse({ error: "foreman_required" }, 403, cors);
  }

  let reservationId: string | null = null;
  const meter = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;
  try {
    const body = await req.json().catch(() => ({}));
    const openingId = typeof body.openingId === "string" ? body.openingId : "";
    if (!UUID.test(openingId)) return jsonResponse({ error: "invalid_opening" }, 400, cors);
    const { data: opening, error: openingError } = await caller.from("project_openings")
      .select("id, opening_code, status").eq("id", openingId).maybeSingle();
    if (openingError) throw openingError;
    if (!opening) return jsonResponse({ error: "opening_not_found" }, 404, cors);
    if (opening.status !== "installed") return jsonResponse({ error: "opening_not_installed" }, 409, cors);

    const { data: events, error: eventsError } = await caller.from("install_events")
      .select("id").eq("project_opening_id", openingId).order("created_at", { ascending: false }).limit(30);
    if (eventsError) throw eventsError;
    const eventIds = (events ?? []).map((event) => event.id);
    if (!eventIds.length) return jsonResponse({ error: "no_install_photo" }, 404, cors);
    const { data: photos, error: photosError } = await caller.from("attachments")
      .select("id, storage_path, created_at")
      .in("install_event_id", eventIds).eq("kind", "photo")
      .order("created_at", { ascending: false }).limit(80);
    if (photosError) throw photosError;
    // The capture flow names its after photo "-after-1.jpg". Never guess from
    // an unrelated before/damage image or accept a client-supplied path.
    const photo = (photos ?? []).find((item) => /-after-\d+\.(jpe?g|png|webp)$/i.test(item.storage_path));
    if (!photo) return jsonResponse({ error: "no_after_photo" }, 404, cors);
    const prefix = "install-media/";
    if (!photo.storage_path.startsWith(prefix)) return jsonResponse({ error: "photo_unavailable" }, 422, cors);

    const gate = await reserveAiSpend(meter, { userId: auth.user.id, functionName: "review-qc-photo" });
    if (gate.alert) await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
      supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
    });
    if (!gate.allowed) return jsonResponse({ error: "ai_spend_limit", note: gate.note }, 429, cors);
    reservationId = gate.reservationId;
    const { data: image, error: downloadError } = await caller.storage.from("install-media")
      .download(photo.storage_path.slice(prefix.length));
    if (downloadError || !image) {
      await releaseAiSpend(meter, reservationId, "photo_download_failed", true);
      reservationId = null;
      return jsonResponse({ error: "photo_unavailable" }, 502, cors);
    }
    if (image.size > MAX_IMAGE_BYTES || !["image/jpeg", "image/png", "image/webp"].includes(image.type)) {
      await releaseAiSpend(meter, reservationId, "photo_unsupported", true);
      reservationId = null;
      return jsonResponse({ error: "photo_unsupported" }, 422, cors);
    }
    const base64 = bytesToBase64(new Uint8Array(await image.arrayBuffer()));
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${requireOpenAI()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        store: false,
        instructions: "You are helping a window and door installation foreman review one AFTER photo. Describe only visible details. Ask specific follow-up questions about potentially relevant flashing, sealant, fit, damage, or finish when the image supports them. Do not infer hidden construction, code compliance, or pass/fail. Never say the installation is approved. Keep it brief and plain-language.",
        input: [{ role: "user", content: [
          { type: "input_text", text: `Review the after-install photo for opening ${opening.opening_code}.` },
          { type: "input_image", image_url: `data:${image.type};base64,${base64}`, detail: "high" },
        ] }],
        text: { format: { type: "json_schema", name: "qc_photo_review", strict: true, schema: SCHEMA } },
        max_output_tokens: 900,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`qc_provider_${response.status}`);
    const result = await response.json();
    const content = (result.output ?? []).flatMap((item: { content?: Array<{ type: string; text?: string }> }) => item.content ?? [])
      .find((item: { type: string }) => item.type === "output_text")?.text;
    if (typeof content !== "string") throw new Error("qc_no_output");
    const review = JSON.parse(content);
    await settleAiSpend(meter, reservationId, {
      inputTokens: result.usage?.input_tokens ?? null,
      outputTokens: result.usage?.output_tokens ?? null,
    }, MODEL);
    reservationId = null;
    return jsonResponse({ review, photoId: photo.id, photoCreatedAt: photo.created_at, openingId }, 200, cors);
  } catch (error) {
    if (reservationId) await releaseAiSpend(meter, reservationId, "qc_review_failed", false);
    await reportCaughtError("review-qc-photo", req, error);
    return jsonResponse({ error: "Could not review this photo right now." }, 502, cors);
  }
}));

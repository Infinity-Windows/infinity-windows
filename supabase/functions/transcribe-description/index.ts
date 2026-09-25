import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import { corsHeaders, jsonResponse, requireOpenAI, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "../_shared/openai.ts";
import { reserveAiSpend, releaseAiSpend, settleAiSpend, notifyOwnersOfSpend, AUDIO_MICROS_PER_SECOND } from "../_shared/spendGuard.ts";
import { withSentry, reportCaughtError } from "../_shared/sentry.ts";
import { DICTATION_MAX_BYTES, DICTATION_MAX_SECONDS, dictationExtension, readDictationBody } from "../_shared/dictation.ts";

// Only returns words. Saving those words still uses the original field's own
// permissions. Audio is held in memory for this call; never put in storage.
Deno.serve(withSentry("transcribe-description", async req => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", {headers: cors});
  if (req.method !== "POST") return jsonResponse({error: "method_not_allowed"}, 405, cors);
  const auth = await verifyCaller(req);
  if (auth.status !== "ok" || auth.user.id === "service_role") return jsonResponse({error: "sign_in_required"}, 401, cors);
  const caller = callerSupabaseClient(req);
  if (!caller) return jsonResponse({error: "sign_in_required"}, 401, cors);
  const {data: profile, error: profileError} = await caller.from("profiles")
    .select("id, access_revoked_at, retired_at").eq("id", auth.user.id).maybeSingle();
  if (profileError || !profile || profile.access_revoked_at || profile.retired_at) return jsonResponse({error: "access_unavailable"}, 403, cors);
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  let reservation: string | null = null;
  try {
    const bytes = await readDictationBody(req);
    let form: FormData;
    try { form = await new Response(bytes, {headers: {"Content-Type": req.headers.get("Content-Type") ?? ""}}).formData(); }
    catch { return jsonResponse({error: "invalid_audio"}, 400, cors); }
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) return jsonResponse({error: "empty_audio"}, 400, cors);
    if (audio.size > DICTATION_MAX_BYTES) return jsonResponse({error: "audio_too_large"}, 413, cors);
    const extension = dictationExtension(audio.type);
    if (!extension) return jsonResponse({error: "unsupported_audio"}, 415, cors);
    // "auto" (Ask's microphone, K2.6): the crew speaks English, Spanish or a
    // mix, and forcing one language makes Whisper mangle the other. The
    // dictation mics on text fields still send the field's language.
    const language = form.get("language");
    if (language !== "en" && language !== "es" && language !== "auto") return jsonResponse({error: "invalid_language"}, 400, cors);
    const key = requireOpenAI();
    const rate = await service.rpc("claim_description_dictation", {p_user_id: auth.user.id});
    if (rate.error) return jsonResponse({error: "temporarily_unavailable"}, 503, cors);
    if (rate.data !== true) return jsonResponse({error: "daily_limit"}, 429, cors);
    const gate = await reserveAiSpend(service, {userId: auth.user.id, functionName: "transcribe-description"});
    if (gate.alert) await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY});
    if (!gate.allowed) return jsonResponse({error: "dictation_limit"}, 429, cors);
    reservation = gate.reservationId;
    const upload = new FormData();
    upload.append("file", audio, `description.${extension}`);
    upload.append("model", "whisper-1");
    if (language !== "auto") upload.append("language", language);
    upload.append("response_format", "verbose_json");
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: {Authorization: `Bearer ${key}`}, body: upload,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`transcription_provider_${response.status}`);
    const result = await response.json();
    const duration = Number(result.duration);
    // Provider duration, never a phone-supplied claim, determines the charge.
    await settleAiSpend(service, reservation, null, "whisper-1", Math.ceil((Number.isFinite(duration) ? Math.max(0, duration) : DICTATION_MAX_SECONDS) * AUDIO_MICROS_PER_SECOND["whisper-1"]));
    reservation = null;
    if (duration > DICTATION_MAX_SECONDS + 5) return jsonResponse({error: "recording_too_long"}, 413, cors);
    const text = typeof result.text === "string" ? result.text.trim() : "";
    return jsonResponse({text}, 200, cors);
  } catch (error) {
    if (reservation) await releaseAiSpend(service, reservation, "dictation_failed", false);
    if (error instanceof Error && ["audio_too_large", "empty_audio"].includes(error.message)) return jsonResponse({error: error.message}, 400, cors);
    await reportCaughtError("transcribe-description", req, error);
    return jsonResponse({error: "transcription_failed"}, 502, cors);
  }
}));

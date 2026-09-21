import { readDictationBody, DICTATION_MAX_BYTES } from "../_shared/dictation.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
  whisperTranscribe,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_MODEL,
  type AnthropicImage,
  anthropicChatJson,
  requireAnthropic,
} from "../_shared/anthropic.ts";
import { bytesToBase64 } from "../_shared/bytes.ts";
import { verifyCaller, callerSupabaseClient } from "../_shared/auth.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";
import { UNEXPECTED_ERROR, reportCaughtError, withSentry } from "../_shared/sentry.ts";

declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

const TOPIC_KEYS = [
  "difficulty",
  "went_well",
  "went_poorly",
  "obstacles",
  "tools_helped",
  "time_vs_estimate",
  "safety_notes",
  "do_again",
] as const;

type TopicMap = Record<(typeof TOPIC_KEYS)[number], string | null> & {
  suggested_grade?: number | null;
  photo_findings?: string[] | null;
};

interface AttachmentRecord {
  id: string;
  kind: string;
  storage_path: string;
  install_event_id: string | null;
  transcribed_at: string | null;
  created_by: string | null;
}

const nullableString = { type: ["string", "null"] };

const TOPICS_SCHEMA = {
  type: "object",
  properties: {
    difficulty: nullableString,
    went_well: nullableString,
    went_poorly: nullableString,
    obstacles: nullableString,
    tools_helped: nullableString,
    time_vs_estimate: nullableString,
    safety_notes: nullableString,
    do_again: nullableString,
    suggested_grade: { type: ["number", "null"] },
    photo_findings: { type: ["array", "null"], items: { type: "string" } },
  },
};

Deno.serve(withSentry("transcribe-install-memo", async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const auth = await verifyCaller(req);
  if (auth.status !== "ok") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }
  const callerId = auth.user.id !== "service_role" ? auth.user.id : null;

  let reservation: string | null = null;
  try {
    // Audio-to-text is the required result. Photo/topic enrichment is optional
    // and must never delay saving the transcript or throw it away.
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }) },
    });

    let normalizedAudio: File | null = null;
    let body;
    if (req.headers.get("Content-Type")?.includes("multipart/form-data")) {
      const bytes = await readDictationBody(req);
      const form = await new Response(bytes, {headers: {"Content-Type": req.headers.get("Content-Type")!}}).formData();
      const file = form.get("transcription_audio");
      if (!(file instanceof File) || !file.size || file.size > DICTATION_MAX_BYTES || file.type !== "audio/wav")
        return jsonResponse({error: "invalid_audio"}, 400, cors);
      normalizedAudio = file;
      body = { attachment_id: form.get("attachment_id") };
    } else body = await req.json().catch(() => ({}));
    const record = (body.record ?? body) as Partial<AttachmentRecord> & {
      attachment_id?: string;
    };

    const caller = callerId ? callerSupabaseClient(req) : supabase;
    if (!caller) return jsonResponse({ error: "unauthorized" }, 401, cors);
    let callerRole = "";
    if (callerId) {
      const { data: profile, error } = await caller.from("profiles")
        .select("id,role,active,is_partner,access_revoked_at,retired_at").eq("id", callerId).maybeSingle();
      if (error || !profile || !profile.active || profile.is_partner || profile.access_revoked_at || profile.retired_at)
        return jsonResponse({ error: "access_unavailable" }, 403, cors);
      callerRole = profile.role;
    }
    // Even webhook-shaped requests resolve the saved row. Never accept a
    // caller-supplied storage path or install ID under service credentials.
    const attachmentId = record.attachment_id ?? record.id;
    if (!attachmentId) return jsonResponse({ error: "attachment_required" }, 400, cors);
    const { data, error: readError } = await caller.from("attachments")
      .select("id,kind,storage_path,install_event_id,transcribed_at,created_by")
      .eq("id", attachmentId).maybeSingle();
    if (readError) throw readError;
    const attachment = data as AttachmentRecord | null;
    if (!attachment || attachment.kind !== "voice_memo") {
      return jsonResponse({ skipped: true, reason: "not a voice_memo" }, 200, cors);
    }
    if (normalizedAudio && callerId !== attachment.created_by && !["foreman", "supervisor", "owner"].includes(callerRole))
      return jsonResponse({ error: "access_unavailable" }, 403, cors);
    if (!attachment.install_event_id) {
      return jsonResponse({ skipped: true, reason: "no install_event_id" }, 200, cors);
    }
    if (attachment.transcribed_at) {
      return jsonResponse({ skipped: true, reason: "already transcribed" }, 200, cors);
    }

    // storage_path is stored as "install-media/<path>"
    const full = attachment.storage_path;
    const slash = full.indexOf("/");
    const bucket = slash >= 0 ? full.slice(0, slash) : "install-media";
    const path = slash >= 0 ? full.slice(slash + 1) : full;

    // The original recording stays in Storage. Its uploader (or a crew lead)
    // may supply a browser-decoded WAV solely for speech recognition.
    let file: Blob = normalizedAudio!;
    if (!file) {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error) throw error;
      file = data;
    }

    // Spend guard, write-time. Placed after every "already done / not a memo"
    // skip above so a no-op invocation books nothing. This one deliberately
    // carries NO role floor and NO per-user daily count: it usually runs as a
    // storage webhook with no end user at all, it is idempotent (a second call
    // on the same memo exits above), and it is bounded by how many memos crew
    // actually record. Blocking it would silently throw away field knowledge
    // that cannot be re-recorded. The company ceiling still applies.
    const gate = await reserveAiSpend(supabase, {
      userId: callerId,
      functionName: "transcribe-install-memo",
    });
    if (gate.alert) {
      await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      });
    }
    if (!gate.allowed) {
      return jsonResponse(
        {
          skipped: true,
          limited: true,
          reason: "the company's monthly AI budget is used up",
          note: "The memo is saved and will transcribe once an owner raises the AI ceiling.",
        },
        200,
        cors,
      );
    }

    reservation = gate.reservationId;
    const filename = normalizedAudio ? "memo.wav" : path.split("/").pop() ?? "memo.webm";
    const transcript = await whisperTranscribe(file, filename, AbortSignal.timeout(45_000));
    if (!transcript.trim()) throw new Error("No speech was detected in this memo.");
    const { error: textError } = await supabase.from("install_events")
      .update({ transcript_raw: transcript }).eq("id", attachment.install_event_id);
    if (textError) throw textError;
    const { error: attachmentError } = await supabase.from("attachments")
      .update({ transcript, transcribed_at: new Date().toISOString() }).eq("id", attachment.id);
    if (attachmentError) throw attachmentError;

    const whisperMicros = Math.max(1_000, Math.round((transcript.length / (150 * 5)) * 6_000));
    const enrich = async () => {
      let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
      try {
        requireAnthropic();
        // Pull the install-event's photos for vision context (before/after).
        //
        // Downloaded as bytes rather than handed over as signed URLs: Claude takes
        // images inline as base64, which is also one less way for this to break —
        // a signed URL that expires or that the provider cannot reach silently cost
        // us the photo context. A photo that fails to download is skipped, because
        // the transcript alone is still worth saving.
        const images: AnthropicImage[] = [];
        const { data: photoRows } = await supabase
          .from("attachments")
          .select("storage_path")
          .eq("install_event_id", attachment.install_event_id)
          .eq("kind", "photo")
          .limit(4);
        for (const row of photoRows ?? []) {
          const p: string = row.storage_path;
          const s = p.indexOf("/");
          const b = s >= 0 ? p.slice(0, s) : "install-media";
          const key = s >= 0 ? p.slice(s + 1) : p;
          try {
            const { data: blob } = await supabase.storage.from(b).download(key);
            if (!blob) continue;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            images.push({
              mediaType: blob.type || "image/jpeg",
              data: bytesToBase64(bytes),
            });
          } catch (e) {
            console.warn("photo download failed, continuing without it", key, e);
          }
        }

        const topics = await anthropicChatJson<TopicMap>({
          system:
            "You process window-install field memos. Split the installer's voice transcript into fixed topic fields, using the before/after photos as extra context. Use null for topics not mentioned. Keep each field concise (1-3 sentences). Also suggest a quality grade 1-5 (5 = flawless install) from the transcript and photos (null if unclear), and list any concrete visual observations from the photos (e.g. 'shim gap uneven on latch side', 'clean flashing tape') as photo_findings.",
          user: `Transcript:\n${transcript}`,
          schemaHint:
            `Schema: { "difficulty": string|null, "went_well": string|null, "went_poorly": string|null, "obstacles": string|null, "tools_helped": string|null, "time_vs_estimate": string|null, "safety_notes": string|null, "do_again": string|null, "suggested_grade": number|null, "photo_findings": string[]|null }`,
          schema: TOPICS_SCHEMA,
          images,
          signal: AbortSignal.timeout(60_000),
          onUsage: (u) => {
            usage = u;
          },
        });

        const patch: Record<string, string | null> = {};
        for (const key of TOPIC_KEYS) {
          const value = topics[key];
          if (typeof value === "string" && value.trim()) {
            patch[key] = value.trim();
          }
        }

        // Only fill empty columns so typed/confirmed notes are never overwritten.
        const { data: existing, error: exErr } = await supabase
          .from("install_events")
          .select(`${TOPIC_KEYS.join(",")}, quality_grade`)
          .eq("id", attachment.install_event_id)
          .single();
        if (exErr) throw exErr;

        const finalPatch: Record<string, string | number | null> = {};
        for (const key of TOPIC_KEYS) {
          const current = (existing as Record<string, string | null>)[key];
          if ((!current || !String(current).trim()) && patch[key]) {
            finalPatch[key] = patch[key];
          }
        }

        // Suggest grade only if the installer didn't set one.
        const existingGrade = (existing as Record<string, number | null>).quality_grade;
        const suggested = Number(topics.suggested_grade);
        if (
          (existingGrade == null) &&
          Number.isFinite(suggested) &&
          suggested >= 1 &&
          suggested <= 5
        ) {
          finalPatch.quality_grade = Math.round(suggested);
        }

        // Persist structured photo observations for later mining.
        if (Array.isArray(topics.photo_findings) && topics.photo_findings.length > 0) {
          (finalPatch as Record<string, unknown>).photo_findings = topics.photo_findings
            .map((s) => String(s).trim())
            .filter(Boolean)
            .slice(0, 8);
        }

        const { error: upErr } = await supabase
          .from("install_events")
          .update(finalPatch)
          .eq("id", attachment.install_event_id);
        if (upErr) throw upErr;

      } catch (error) {
        await reportCaughtError("transcribe-install-memo", req, error);
      } finally {
        await settleAiSpend(supabase, gate.reservationId, usage, ANTHROPIC_MODEL, whisperMicros);
      }
    };
    // Supabase keeps this promise alive after responding. Failed enrichment
    // leaves the already-saved audio/transcript available for manual review.
    const background = enrich().catch(error => reportCaughtError("transcribe-install-memo", req, error));
    reservation = null; // settlement now belongs to the background task
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(background);
    else await background;

    return jsonResponse(
      { ok: true, attachment_id: attachment.id, chars: transcript.length, transcript, enrichment: "background" },
      200,
      cors,
    );
  } catch (e) {
    if (reservation) await releaseAiSpend(createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), reservation, "memo_failed", false);
    // withSentry only ever sees a throw that ESCAPES the handler, and this one
    // never does — so report it here, or nobody finds out this has been failing
    // since Tuesday. Then one plain sentence: String(e) hands whoever is
    // holding the phone a Postgres constraint name (CLAUDE.md).
    await reportCaughtError("transcribe-install-memo", req, e);
    return jsonResponse({ error: UNEXPECTED_ERROR }, 500, cors);
  }
}));

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
import { verifyCaller } from "../_shared/auth.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";

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

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }
  const callerId =
    auth.status === "ok" && auth.user.id !== "service_role" ? auth.user.id : null;

  try {
    // This is the one function that genuinely needs BOTH providers: Whisper
    // (OpenAI) turns the audio into words, Claude sorts those words into topic
    // fields and reads the photos. Checked up front so a missing Anthropic key
    // costs nothing — the old order paid for the transcription first and then
    // threw it away when the second call failed.
    requireAnthropic();
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = await req.json().catch(() => ({}));
    const record = (body.record ?? body) as Partial<AttachmentRecord> & {
      attachment_id?: string;
    };

    let attachment: AttachmentRecord | null = null;
    if (record.id) {
      attachment = record as AttachmentRecord;
    } else if (record.attachment_id) {
      const { data, error } = await supabase
        .from("attachments")
        .select("id, kind, storage_path, install_event_id, transcribed_at")
        .eq("id", record.attachment_id)
        .maybeSingle();
      if (error) throw error;
      attachment = data;
    }

    if (!attachment || attachment.kind !== "voice_memo") {
      return jsonResponse({ skipped: true, reason: "not a voice_memo" }, 200, cors);
    }
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

    const { data: file, error: dlErr } = await supabase.storage
      .from(bucket)
      .download(path);
    if (dlErr) throw dlErr;

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

    const filename = path.split("/").pop() ?? "memo.webm";
    const transcript = await whisperTranscribe(file, filename).catch(async (err) => {
      await releaseAiSpend(supabase, gate.reservationId, "whisper_failed", false);
      throw err;
    });

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

    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    const topics = await anthropicChatJson<TopicMap>({
      system:
        "You process window-install field memos. Split the installer's voice transcript into fixed topic fields, using the before/after photos as extra context. Use null for topics not mentioned. Keep each field concise (1-3 sentences). Also suggest a quality grade 1-5 (5 = flawless install) from the transcript and photos (null if unclear), and list any concrete visual observations from the photos (e.g. 'shim gap uneven on latch side', 'clean flashing tape') as photo_findings.",
      user: `Transcript:\n${transcript}`,
      schemaHint:
        `Schema: { "difficulty": string|null, "went_well": string|null, "went_poorly": string|null, "obstacles": string|null, "tools_helped": string|null, "time_vs_estimate": string|null, "safety_notes": string|null, "do_again": string|null, "suggested_grade": number|null, "photo_findings": string[]|null }`,
      schema: TOPICS_SCHEMA,
      images,
      onUsage: (u) => {
        usage = u;
      },
    });

    // Whisper bills by audio minute, not tokens, so the transcript length is the
    // only signal we have: ~150 spoken words a minute, ~5 characters a word,
    // $0.006 a minute = 6,000 micro-dollars. The vision pass is priced from its
    // real token counts on top.
    const whisperMicros = Math.max(
      1_000,
      Math.round((transcript.length / (150 * 5)) * 6_000),
    );
    await settleAiSpend(
      supabase,
      gate.reservationId,
      usage,
      ANTHROPIC_MODEL,
      whisperMicros,
    );

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

    const finalPatch: Record<string, string | number | null> = {
      transcript_raw: transcript,
    };
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

    const { error: attErr } = await supabase
      .from("attachments")
      .update({
        transcribed_at: new Date().toISOString(),
        transcript,
      })
      .eq("id", attachment.id);
    if (attErr) throw attErr;

    return jsonResponse(
      { ok: true, attachment_id: attachment.id, chars: transcript.length },
      200,
      cors,
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

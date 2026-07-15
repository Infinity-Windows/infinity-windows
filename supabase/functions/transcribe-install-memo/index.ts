import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  chatJson,
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
  whisperTranscribe,
} from "../_shared/openai.ts";

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

type TopicMap = Record<(typeof TOPIC_KEYS)[number], string | null>;

interface AttachmentRecord {
  id: string;
  kind: string;
  storage_path: string;
  install_event_id: string | null;
  transcribed_at: string | null;
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
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

    const filename = path.split("/").pop() ?? "memo.webm";
    const transcript = await whisperTranscribe(file, filename);

    const topics = await chatJson<TopicMap>(
      "You split window-install voice memos into fixed topic fields. Use null for topics not mentioned. Keep each field concise (1-3 sentences).",
      transcript,
      `Schema: { "difficulty": string|null, "went_well": string|null, "went_poorly": string|null, "obstacles": string|null, "tools_helped": string|null, "time_vs_estimate": string|null, "safety_notes": string|null, "do_again": string|null }`,
    );

    const patch: Record<string, string | null> = {
      transcript_raw: transcript,
    };
    for (const key of TOPIC_KEYS) {
      const value = topics[key];
      if (typeof value === "string" && value.trim()) {
        patch[key] = value.trim();
      }
    }

    // Only fill empty topic columns so typed notes are never overwritten.
    const { data: existing, error: exErr } = await supabase
      .from("install_events")
      .select(TOPIC_KEYS.join(","))
      .eq("id", attachment.install_event_id)
      .single();
    if (exErr) throw exErr;

    const finalPatch: Record<string, string | null> = {
      transcript_raw: transcript,
    };
    for (const key of TOPIC_KEYS) {
      const current = (existing as Record<string, string | null>)[key];
      if ((!current || !String(current).trim()) && patch[key]) {
        finalPatch[key] = patch[key];
      }
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

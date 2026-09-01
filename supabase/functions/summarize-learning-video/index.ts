// Wave Q, Q1: one Claude call that returns BOTH a plain-English summary and a
// 5-question multiple-choice quiz for a training video, grounded only in its
// transcript. Mirrors extract-receipt's shape wholesale (verifyCaller, the
// spend guard's reserve/settle/release trio, one anthropicChatJson call,
// degrade-not-500), with two differences that shape follow from the
// ground-truth wave A crew-board precedent and the transcript-source rule
// grill Q1 settled: (1) this function is compute-only in BOTH directions —
// it never writes learning_video_quizzes itself, the client persists the
// draft via save_video_quiz_draft (20260962000000), same "edge function
// computes, client writes" split extract-receipt/extract-specs already use;
// (2) it also serves a second, unrelated action — "transcribe" — because the
// UI needs Whisper on an UPLOADED file's own stored copy before Generate has
// anything to read (Q1: paste-or-Whisper, the app never scrapes YouTube).
// Two actions, one function, so there is exactly ONE new ANTHROPIC_API_KEY
// consumer for the secrets census to learn about.
//
// The transcribe action's OPENAI_API_KEY read is guarded exactly like ask's
// RAG step (`if (Deno.env.get("OPENAI_API_KEY")) { ... }`) — feature-detect,
// degrade, never break — so it stays OPTIONAL for this function rather than
// becoming a second required secret. Whisper is already OPENAI_API_KEY's
// existing job (transcribe-install-memo); nothing here changes who is
// required to have it.

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
  anthropicChatJson,
  requireAnthropic,
  type AnthropicUsage,
} from "../_shared/anthropic.ts";
import type { JsonSchema } from "../_shared/anthropicJson.ts";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
  type SpendVerdict,
} from "../_shared/spendGuard.ts";

export interface QuizQuestion {
  q: string;
  choices: string[];
  correct_idx: number;
  why: string;
}

export interface VideoQuizGeneration {
  summary: string;
  questions: QuizQuestion[];
}

const SYSTEM =
  "You write training material for a window/door install crew from one " +
  "lesson's transcript. Write a plain-English summary (12th-grade reading " +
  "level, a paragraph or two) and a 5-question multiple-choice quiz that " +
  "checks whether someone actually watched and understood the lesson. " +
  "Everything you write must be grounded ONLY in the transcript — never " +
  "invent a tool, step, measurement or fact the transcript does not state. " +
  "Return STRICT JSON only, no prose, no markdown fences.";

const SCHEMA_HINT =
  'Schema: { "summary": string, "questions": [ { "q": string, ' +
  '"choices": [string, string, string, string], "correct_idx": integer, ' +
  '"why": string } ] }. questions has EXACTLY 5 items. Each question has ' +
  "EXACTLY 4 choices and correct_idx is the 0-based index into choices of " +
  'the right one. "why" is ONE short sentence, shown to the learner right ' +
  "after they answer that question — it explains the right answer using " +
  "only what the transcript said.";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          q: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          correct_idx: { type: "integer" },
          why: { type: "string" },
        },
      },
    },
  },
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Validate and normalize the model's raw answer into exactly the shape
 * save_video_quiz_draft requires (5 questions, 4 choices each, correct_idx
 * in range). Throws rather than coerce a malformed answer into something
 * that LOOKS fine — a quiz with a wrong correct_idx from silent padding is
 * worse than a failed generation, because nothing about it looks wrong until
 * an installer gets marked wrong for the right answer.
 */
function cleanGeneration(raw: unknown): VideoQuizGeneration {
  const o = (raw ?? {}) as Record<string, unknown>;
  const summary = str(o.summary);
  if (!summary) {
    throw new Error("Anthropic's answer had no summary");
  }
  const rawQuestions = Array.isArray(o.questions) ? o.questions : [];
  if (rawQuestions.length !== 5) {
    throw new Error(
      `Anthropic returned ${rawQuestions.length} questions, not 5`,
    );
  }
  const questions = rawQuestions.map((rq, i) => {
    const r = (rq ?? {}) as Record<string, unknown>;
    const q = str(r.q);
    const choices = Array.isArray(r.choices) ? r.choices.map(str) : [];
    const correctIdx = Number(r.correct_idx);
    const why = str(r.why);
    if (!q || choices.length !== 4 || choices.some((c) => !c)) {
      throw new Error(`Question ${i + 1} is missing its text or 4 choices`);
    }
    if (!Number.isInteger(correctIdx) || correctIdx < 0 || correctIdx > 3) {
      throw new Error(`Question ${i + 1}'s correct answer is out of range`);
    }
    if (!why) {
      throw new Error(`Question ${i + 1} is missing its explanation`);
    }
    return { q, choices, correct_idx: correctIdx, why };
  });
  return { summary, questions };
}

interface VideoRow {
  video_path: string | null;
  youtube_url: string | null;
}

/** ~150 spoken words/min, ~5 chars/word, $0.006/min Whisper pricing — the
 * same estimate transcribe-install-memo uses when there is no per-call
 * token count to reconcile against. */
function whisperMicrosFor(transcript: string): number {
  return Math.max(1_000, Math.round((transcript.length / (150 * 5)) * 6_000));
}

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
    const body = await req.json().catch(() => ({}));
    const videoId = str(body.videoId);
    const action = body.action === "transcribe" ? "transcribe" : "generate";
    if (!videoId) {
      return jsonResponse({ error: "videoId is required" }, 400, cors);
    }

    // Same floor as who may author a training video at all (save_learning_
    // video, 20260816000000): a supervisor or above. Read as the CALLER so
    // this cannot be tricked into acting for someone the RLS/role checks
    // downstream would refuse — extract-receipt's "read as the caller" note
    // applies here too.
    const caller = callerSupabaseClient(req);
    if (!caller) {
      return jsonResponse({ error: "unauthorized" }, 401, cors);
    }
    const { data: rankData, error: rankErr } = await caller.rpc("my_role_rank");
    const rank = rankErr || typeof rankData !== "number" ? 0 : rankData;
    if (rank < 2) {
      return jsonResponse(
        { error: "Only a supervisor or above can generate a summary and quiz." },
        403,
        cors,
      );
    }

    const meter =
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        : null;

    if (action === "transcribe") {
      const { data: videoRow, error: videoErr } = await caller
        .from("learning_videos")
        .select("video_path, youtube_url")
        .eq("id", videoId)
        .maybeSingle();
      if (videoErr) {
        return jsonResponse({ error: videoErr.message }, 400, cors);
      }
      const video = videoRow as VideoRow | null;
      if (!video?.video_path) {
        return jsonResponse(
          {
            error:
              "This video has no uploaded file to transcribe — paste the transcript instead.",
          },
          400,
          cors,
        );
      }

      // Feature-detect, degrade, never break — the ask/index.ts pattern
      // (`if (Deno.env.get("OPENAI_API_KEY")) { ... }`), which is also what
      // keeps OPENAI_API_KEY OPTIONAL rather than required for this
      // function in the secrets census: scripts/function_secrets.py demotes
      // a var the moment this exact guard shape appears anywhere in the
      // file, the same rule ask's own RAG step relies on.
      if (Deno.env.get("OPENAI_API_KEY")) {
        const gate: SpendVerdict = await reserveAiSpend(meter, {
          userId: callerId,
          functionName: "summarize-learning-video",
          kind: "content",
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
              ok: true,
              skipped: true,
              limited: true,
              limit_reason: gate.reason,
              note:
                "The company's monthly AI budget is used up, so this video wasn't transcribed automatically. Paste the transcript instead, or an owner can raise the ceiling on the AI spend screen.",
            },
            200,
            cors,
          );
        }

        const slash = video.video_path.indexOf("/");
        const bucket = slash >= 0 ? video.video_path.slice(0, slash) : "learning-videos";
        const key = slash >= 0 ? video.video_path.slice(slash + 1) : video.video_path;
        const { data: blob, error: downloadErr } = await caller.storage.from(bucket).download(key);
        if (downloadErr || !blob) {
          await releaseAiSpend(meter, gate.reservationId, "video_download_failed", true);
          return jsonResponse({ error: "could not read the uploaded video" }, 502, cors);
        }

        let transcript: string;
        try {
          transcript = await whisperTranscribe(blob, key.split("/").pop() ?? "video.mp4");
        } catch (err) {
          await releaseAiSpend(meter, gate.reservationId, "whisper_failed", true);
          console.error("summarize-learning-video transcribe failed", err);
          return jsonResponse({ error: "could not transcribe this video" }, 502, cors);
        }

        await settleAiSpend(
          meter,
          gate.reservationId,
          { inputTokens: 0, outputTokens: 0 },
          ANTHROPIC_MODEL,
          whisperMicrosFor(transcript),
        );

        return jsonResponse({ ok: true, transcript }, 200, cors);
      }

      // Whisper isn't configured on this project — say so plainly rather
      // than 500. Nothing was lost: the video is still there to paste a
      // transcript against by hand.
      return jsonResponse(
        {
          ok: true,
          skipped: true,
          reason: "transcription_not_configured",
          note: "Automatic transcription isn't set up yet — paste the transcript instead.",
        },
        200,
        cors,
      );
    }

    // action === "generate"
    requireAnthropic();
    const title = str(body.title);
    const transcript = str(body.transcript);
    if (!transcript) {
      return jsonResponse({ error: "transcript is required" }, 400, cors);
    }

    const gate: SpendVerdict = await reserveAiSpend(meter, {
      userId: callerId,
      functionName: "summarize-learning-video",
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
          ok: true,
          skipped: true,
          limited: true,
          limit_reason: gate.reason,
          generation: null,
          note:
            "The company's monthly AI budget is used up, so this lesson wasn't summarized automatically. An owner can raise the ceiling on the AI spend screen and try again.",
        },
        200,
        cors,
      );
    }

    let usage: AnthropicUsage = { inputTokens: 0, outputTokens: 0 };
    let generation: VideoQuizGeneration;
    try {
      const raw = await anthropicChatJson<Record<string, unknown>>({
        system: SYSTEM,
        user: `Lesson title: ${title || "(untitled)"}\n\nTranscript:\n${transcript}`,
        schemaHint: SCHEMA_HINT,
        schema: SCHEMA,
        model: ANTHROPIC_MODEL,
        maxTokens: 2048,
        onUsage: (u) => {
          usage = u;
        },
      });
      generation = cleanGeneration(raw);
    } catch (err) {
      await releaseAiSpend(meter, gate.reservationId, "no_provider_response", true);
      console.error("summarize-learning-video generate failed", err);
      return jsonResponse({ error: "could not generate a summary and quiz" }, 502, cors);
    }

    await settleAiSpend(meter, gate.reservationId, usage, ANTHROPIC_MODEL);

    return jsonResponse({ ok: true, skipped: false, generation }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

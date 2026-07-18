import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  chatJson,
  corsHeaders,
  jsonResponse,
  OPENAI_API_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import { requireCaller } from "../_shared/auth.ts";

interface TalkResult {
  title: string;
  intro: string;
  key_hazards: string[];
  steps: string[];
  dos: string[];
  donts: string[];
  visual_aid_prompts: string[];
}

interface VisualAid {
  prompt: string;
  url?: string;
}

const clean = (xs: unknown, max: number): string[] =>
  (Array.isArray(xs) ? xs : [])
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .slice(0, max);

/**
 * Best-effort image generation. Returns a data URL on success, null on any
 * failure — the caller must never crash when images are unavailable.
 */
async function tryGenerateImage(prompt: string): Promise<string | null> {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt:
          "Clean, simple safety training diagram, flat vector illustration, " +
          "high contrast, minimal text labels: " + prompt,
        size: "1024x1024",
        n: 1,
      }),
    });
    if (!res.ok) {
      console.warn("image gen failed", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    const url = data?.data?.[0]?.url;
    if (b64) return `data:image/png;base64,${b64}`;
    if (url) return String(url);
    return null;
  } catch (e) {
    console.warn("image gen error", e);
    return null;
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const unauthorized = await requireCaller(req, cors);
  if (unauthorized) return unauthorized;

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const talkId = typeof body.talk_id === "string" ? body.talk_id : null;
    const withImages = body.with_images !== false; // opt-out; best-effort either way
    let topic = typeof body.topic === "string" ? body.topic.trim() : "";

    // Resolve the target talk. Accept a talk_id (regenerate an existing talk)
    // or a topic (create a new talk row for today).
    let targetId = talkId;
    if (targetId) {
      const { data: existing, error } = await supabase
        .from("safety_talks")
        .select("id, title")
        .eq("id", targetId)
        .maybeSingle();
      if (error) throw error;
      if (!existing) return jsonResponse({ error: "unknown talk_id" }, 404, cors);
      if (!topic) topic = existing.title;
    }
    if (!topic) {
      return jsonResponse({ error: "topic or talk_id required" }, 400, cors);
    }

    const result = await chatJson<TalkResult>(
      `You are a construction safety trainer writing a daily toolbox talk for a residential/commercial window & door install crew. Make it genuinely educational, not boilerplate: explain WHY each hazard matters and HOW to work safely in plain, direct language a busy installer will actually read. Be specific to the topic. Keep every line concrete and actionable.`,
      `Topic: ${topic}`,
      `Schema: {
        "title": string (short, punchy),
        "intro": string (2-3 sentences: what this talk covers and why it matters today),
        "key_hazards": string[3-5] (the real dangers, each one specific),
        "steps": string[4-7] (step-by-step safe procedure, imperative),
        "dos": string[3-5] (short do's),
        "donts": string[3-5] (short don'ts),
        "visual_aid_prompts": string[1-2] (image descriptions for a simple safety diagram)
      }`,
    );

    const sections = {
      intro: String(result.intro ?? "").trim(),
      key_hazards: clean(result.key_hazards, 5),
      steps: clean(result.steps, 7),
      dos: clean(result.dos, 5),
      donts: clean(result.donts, 5),
    };
    const prompts = clean(result.visual_aid_prompts, 2);
    const title = String(result.title ?? topic).trim() || topic;

    // Visual aids: best-effort image generation, else described placeholders.
    const visualAids: VisualAid[] = [];
    for (const prompt of prompts) {
      const url = withImages ? await tryGenerateImage(prompt) : null;
      visualAids.push(url ? { prompt, url } : { prompt });
    }

    // Compose a readable plain-text body too, so older UI / the PDF snapshot
    // and any client that only reads `body` still shows the full content.
    const body_text = [
      sections.intro,
      sections.key_hazards.length
        ? "Key hazards:\n- " + sections.key_hazards.join("\n- ")
        : "",
      sections.steps.length
        ? "Steps:\n" + sections.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
        : "",
      sections.dos.length ? "Do:\n- " + sections.dos.join("\n- ") : "",
      sections.donts.length ? "Don't:\n- " + sections.donts.join("\n- ") : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (targetId) {
      const { error: upErr } = await supabase
        .from("safety_talks")
        .update({
          title,
          body: body_text || title,
          sections_json: sections,
          visual_aids_json: visualAids,
        })
        .eq("id", targetId);
      if (upErr) throw upErr;
    } else {
      const { data: created, error: insErr } = await supabase
        .from("safety_talks")
        .insert({
          title,
          body: body_text || title,
          sections_json: sections,
          visual_aids_json: visualAids,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      targetId = created.id;
    }

    return jsonResponse(
      {
        ok: true,
        talk_id: targetId,
        title,
        images: visualAids.filter((v) => v.url).length,
        aids: visualAids.length,
      },
      200,
      cors,
    );
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

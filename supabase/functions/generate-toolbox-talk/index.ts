import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  OPENAI_API_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_MODEL,
  anthropicChatJson,
  requireAnthropic,
} from "../_shared/anthropic.ts";
import { toStringList } from "../_shared/anthropicJson.ts";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import {
  IMAGE_MICROS,
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";
import { UNEXPECTED_ERROR, reportCaughtError, withSentry } from "../_shared/sentry.ts";

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
  // Reviewer state (training illustration editor, 2026-09-30). Lives inside
  // this same jsonb value — no migration — so an old row with none of these
  // keys is treated as already approved (app/src/lib/toolbox.ts's
  // visibleVisualAids is the single source of truth for that rule).
  approved?: boolean;
  approvedBy?: string | null;
  approvedAt?: string | null;
}

// Verified against the Images API and response usage on 2026-09-30.
const IMAGE_MODEL = "gpt-image-2.5-flare";
type GeneratedImage = { url: string; costMicros: number };

/** Direct Images API: text input $5/M, image input $8/M, image output $30/M. */
function imageCostMicros(usage: Record<string, unknown> | undefined): number {
  const input = (usage?.input_tokens_details ?? {}) as Record<string, unknown>;
  const output = (usage?.output_tokens_details ?? {}) as Record<string, unknown>;
  const text = Number(input.text_tokens);
  const imageIn = Number(input.image_tokens);
  const imageOut = Number(output.image_tokens);
  // Missing usage should never make a paid image look free on the owner screen.
  if (![text, imageIn, imageOut].every(Number.isFinite)) return IMAGE_MICROS;
  return Math.ceil(Math.max(0, text) * 5 + Math.max(0, imageIn) * 8 + Math.max(0, imageOut) * 30);
}

const stringList = { type: "array", items: { type: "string" } };

const TALK_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    intro: { type: "string" },
    key_hazards: stringList,
    steps: stringList,
    dos: stringList,
    donts: stringList,
    visual_aid_prompts: stringList,
  },
  required: [
    "title",
    "intro",
    "key_hazards",
    "steps",
    "dos",
    "donts",
    "visual_aid_prompts",
  ],
};

const clean = (xs: unknown, max: number): string[] =>
  toStringList(xs).slice(0, max);

/**
 * Best-effort safety diagram. Returns a data URL on success, null on any
 * failure — the caller must never crash when images are unavailable.
 *
 * The one part of this function still on OpenAI, and deliberately so: Anthropic
 * generates no images. Claude writes the words; only the picture comes from
 * here, so with no OpenAI key the talk still ships, with described placeholders
 * in place of diagrams.
 *
 * The `Deno.env.get(...)` truthiness test is doing two jobs. It feature-detects
 * at runtime, and it is the exact shape scripts/function_secrets.py reads as
 * "optional — absence degrades instead of breaking", which is what stops the
 * deploy from demanding an OpenAI key for a function whose text no longer needs
 * one.
 */
async function tryGenerateImage(prompt: string): Promise<GeneratedImage | null> {
  if (Deno.env.get("OPENAI_API_KEY")) {
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt:
            "Clean, simple safety training diagram, flat vector illustration, " +
            "high contrast, minimal text labels: " + prompt,
          size: "1024x1024",
          quality: "medium",
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
      if (b64) return { url: `data:image/png;base64,${b64}`, costMicros: imageCostMicros(data.usage) };
      if (url) return { url: String(url), costMicros: imageCostMicros(data.usage) };
    } catch (e) {
      console.warn("image gen error", e);
    }
  }
  return null;
}

/**
 * Regenerate ONE illustration on an existing talk — the reviewer's "revise
 * the prompt, get a fresh picture" action. Priced and gated as a single
 * image, never the whole-talk estimate: `spendOverride` replaces the
 * registry lookup so the meter only books what this call can actually cost.
 * Never touches sections_json, title, or any other illustration.
 */
async function handleIllustrationRegen(
  supabase: ReturnType<typeof createClient>,
  callerId: string | null,
  body: Record<string, unknown>,
  cors: HeadersInit,
): Promise<Response> {
  const talkId = typeof body.talk_id === "string" ? body.talk_id : null;
  const aidIndex = typeof body.aid_index === "number" ? body.aid_index : null;
  if (!talkId || aidIndex === null || aidIndex < 0) {
    return jsonResponse({ error: "talk_id and aid_index required" }, 400, cors);
  }

  const gate = await reserveAiSpend(supabase, {
    userId: callerId,
    functionName: "generate-toolbox-talk",
    spendOverride: {
      kind: "content",
      provider: "openai",
      model: IMAGE_MODEL,
      estimateMicros: IMAGE_MICROS,
    },
  });
  if (gate.alert) {
    await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
      supabaseUrl: SUPABASE_URL,
      serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
    });
  }
  if (!gate.allowed) {
    return jsonResponse(
      { skipped: true, limited: true, limit_reason: gate.reason, note: gate.note },
      200,
      cors,
    );
  }

  const { data: talk, error } = await supabase
    .from("safety_talks")
    .select("id, visual_aids_json")
    .eq("id", talkId)
    .maybeSingle();
  if (error) throw error;
  const aids: VisualAid[] = Array.isArray(talk?.visual_aids_json)
    ? ((talk!.visual_aids_json as VisualAid[]).slice())
    : [];
  const current = aids[aidIndex];
  if (!current) {
    await releaseAiSpend(supabase, gate.reservationId, "unknown_aid_index", true);
    return jsonResponse({ error: "no illustration at that position" }, 404, cors);
  }

  const prompt = (typeof body.prompt === "string" ? body.prompt.trim() : "") || current.prompt;
  if (!prompt) {
    await releaseAiSpend(supabase, gate.reservationId, "no_prompt", true);
    return jsonResponse({ error: "prompt required" }, 400, cors);
  }

  const generated = await tryGenerateImage(prompt);
  if (!generated) {
    // The provider was reached (or a genuine attempt was made) and came back
    // with nothing usable — a provider failure, not a bad request. The call
    // count stays spent (spendGuard.ts's rule for exactly this case); the
    // money is released, and the existing illustration — approved or not —
    // is left completely untouched.
    await releaseAiSpend(supabase, gate.reservationId, "image_failed", false);
    return jsonResponse({ ok: false, error: "image generation failed" }, 200, cors);
  }

  // A changed picture always needs a fresh look, even if the slot it
  // replaces was already approved — the approval was for the OLD picture.
  aids[aidIndex] = { prompt, url: generated.url, approved: false, approvedBy: null, approvedAt: null };
  const { error: upErr } = await supabase
    .from("safety_talks")
    .update({ visual_aids_json: aids })
    .eq("id", talkId);
  if (upErr) throw upErr;

  await settleAiSpend(supabase, gate.reservationId, null, IMAGE_MODEL, generated.costMicros);
  return jsonResponse(
    { ok: true, talk_id: talkId, aid_index: aidIndex, url: generated.url, approved: false },
    200,
    cors,
  );
}

Deno.serve(withSentry("generate-toolbox-talk", async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = await verifyCaller(req);
  if (auth.status !== "ok" || auth.user.id === "service_role") {
    return jsonResponse({ error: "unauthorized" }, 401, cors);
  }
  const caller = callerSupabaseClient(req);
  if (!caller) return jsonResponse({ error: "unauthorized" }, 401, cors);
  const { data: profile, error: profileError } = await caller.from("profiles")
    .select("id, retired_at, access_revoked_at").eq("id", auth.user.id).maybeSingle();
  if (profileError || !profile || profile.retired_at || profile.access_revoked_at) {
    return jsonResponse({ error: "access_unavailable" }, 403, cors);
  }
  const { data: roleRank, error: roleError } = await caller.rpc("my_role_rank");
  if (roleError || typeof roleRank !== "number" || roleRank < 1) {
    return jsonResponse({ error: "foreman_required" }, 403, cors);
  }
  const callerId = auth.user.id;

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase env not configured");
    }
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));

    // One image, priced and gated on its own — the reviewer's "revise the
    // prompt, try again" action, not a whole-talk regeneration.
    if (body.action === "illustration") {
      return await handleIllustrationRegen(supabase, callerId, body, cors);
    }

    // Claude writes the talk. The OpenAI key is optional here — it only buys the
    // diagrams, and `tryGenerateImage` already copes with its absence.
    requireAnthropic();

    // Spend guard. Treated like a crew question rather than a batch job: it is
    // person-triggered, repeatable at will, and the two generated diagrams make
    // it the priciest single tap in the app (~8 cents against Ask's 2.7). So it
    // takes the same role floor and the same per-user daily count.
    //
    // A refusal is a 200 `skipped`, not an error — the Safety screen keeps the
    // talk it already has rather than showing a red banner.
    const gate = await reserveAiSpend(supabase, {
      userId: callerId,
      functionName: "generate-toolbox-talk",
    });
    if (gate.alert) {
      await notifyOwnersOfSpend(gate.alert, gate.alertProfileIds, {
        supabaseUrl: SUPABASE_URL,
        serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      });
    }
    if (!gate.allowed) {
      return jsonResponse(
        { skipped: true, limited: true, limit_reason: gate.reason, note: gate.note },
        200,
        cors,
      );
    }

    const talkId = typeof body.talk_id === "string" ? body.talk_id : null;
    const withImages = body.with_images !== false; // opt-out; best-effort either way
    let topic = typeof body.topic === "string" ? body.topic.trim() : "";

    // Resolve the target talk. Accept a talk_id (regenerate an existing talk)
    // or a topic (create a new talk row for today). Pulls the CURRENT
    // sections_json / visual_aids_json too: a regen must know what a foreman
    // has already locked in before it decides what it's allowed to replace.
    let targetId = talkId;
    let sectionsLocked = false;
    let priorAids: VisualAid[] = [];
    if (targetId) {
      const { data: existing, error } = await supabase
        .from("safety_talks")
        .select("id, title, sections_json, visual_aids_json")
        .eq("id", targetId)
        .maybeSingle();
      if (error) throw error;
      if (!existing) {
        await releaseAiSpend(supabase, gate.reservationId, "unknown_talk_id", true);
        return jsonResponse({ error: "unknown talk_id" }, 404, cors);
      }
      if (!topic) topic = existing.title;
      sectionsLocked = Boolean(
        (existing.sections_json as { edited?: boolean } | null)?.edited,
      );
      priorAids = Array.isArray(existing.visual_aids_json)
        ? (existing.visual_aids_json as VisualAid[])
        : [];
    }
    if (!topic) {
      await releaseAiSpend(supabase, gate.reservationId, "no_topic", true);
      return jsonResponse({ error: "topic or talk_id required" }, 400, cors);
    }

    let usage: { inputTokens: number | null; outputTokens: number | null } | null = null;
    const result = await anthropicChatJson<TalkResult>({
      system:
        `You are a construction safety trainer writing a daily toolbox talk for a residential/commercial window & door install crew. Make it genuinely educational, not boilerplate: explain WHY each hazard matters and HOW to work safely in plain, direct language a busy installer will actually read. Be specific to the topic. Keep every line concrete and actionable.`,
      user: `Topic: ${topic}`,
      schemaHint: `Schema: {
        "title": string (short, punchy),
        "intro": string (2-3 sentences: what this talk covers and why it matters today),
        "key_hazards": string[3-5] (the real dangers, each one specific),
        "steps": string[4-7] (step-by-step safe procedure, imperative),
        "dos": string[3-5] (short do's),
        "donts": string[3-5] (short don'ts),
        "visual_aid_prompts": string[1-2] (image descriptions for a simple safety diagram)
      }`,
      schema: TALK_SCHEMA,
      onUsage: (u) => {
        usage = u;
      },
    });

    const sections = {
      intro: String(result.intro ?? "").trim(),
      key_hazards: clean(result.key_hazards, 5),
      steps: clean(result.steps, 7),
      dos: clean(result.dos, 5),
      donts: clean(result.donts, 5),
    };
    const prompts = clean(result.visual_aid_prompts, 2);
    const title = String(result.title ?? topic).trim() || topic;

    // Refuse a talk with no hazards AND no steps. Stricter than the app's own
    // "is this talk empty" test, which an intro alone satisfies — and an intro
    // alone is exactly what came back live. A talk is the hazards and the
    // procedure; without either, a crew member is being asked to read and sign
    // nothing before they can clock in. The words the provider already generated
    // are still paid for and settled: refusing to save them is not a refund.
    if (!sections.key_hazards.length && !sections.steps.length) {
      await settleAiSpend(supabase, gate.reservationId, usage, ANTHROPIC_MODEL, 0);
      throw new Error(
        "the AI returned a talk with no content in it, so nothing was saved",
      );
    }

    // Visual aids: best-effort image generation, else described placeholders.
    // Freshly made every time — which slots actually land in the talk is
    // decided by the merge below.
    const freshAids: VisualAid[] = [];
    let generatedImageMicros = 0;
    let newlyGenerated = 0;
    for (let i = 0; i < prompts.length; i++) {
      if (priorAids[i]?.approved === true) {
        freshAids.push(priorAids[i]);
        continue;
      }
      const prompt = prompts[i];
      const generated = withImages ? await tryGenerateImage(prompt) : null;
      if (generated) {
        generatedImageMicros += generated.costMicros;
        newlyGenerated++;
      }
      freshAids.push(generated ? { prompt, url: generated.url } : { prompt });
    }

    // A foreman-approved illustration survives a regen untouched — approval
    // was a decision about THAT picture, and a regen must never silently
    // replace it. Everything else (legacy aids, never-reviewed aids, or a
    // slot with nothing prior) gets the fresh pull, landing pending review
    // exactly like a brand-new talk's illustrations do. `newlyGenerated`
    // counts only the ones actually billed — a kept-as-is aid was never
    // regenerated and must never be charged for again.
    const visualAids: VisualAid[] = freshAids.map((fresh, i) => {
      const prior = priorAids[i];
      if (prior?.approved === true) return prior;
      return { ...fresh, approved: false, approvedBy: null, approvedAt: null };
    });
    // The prompt count can shrink between regens; an approved aid past the
    // end of the fresh list must not just vanish.
    for (let i = freshAids.length; i < priorAids.length; i++) {
      if (priorAids[i]?.approved === true) visualAids.push(priorAids[i]);
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
      // A hand-edited talk (updateTalkSections stamped `edited` on
      // sections_json) keeps its own words — title and visual_aids_json
      // still update, but the AI's freshly written sections/body are
      // dropped on the floor rather than silently overwriting a foreman's.
      const patch: Record<string, unknown> = { visual_aids_json: visualAids };
      if (!sectionsLocked) {
        patch.title = title;
        patch.body = body_text || title;
        patch.sections_json = sections;
      }
      const { error: upErr } = await supabase
        .from("safety_talks")
        .update(patch)
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

    // Real cost = the words the provider charged for, plus a flat charge per
    // image NEWLY generated. Images that failed, or that were kept as-is
    // because they were already approved, cost nothing.
    await settleAiSpend(
      supabase,
      gate.reservationId,
      usage,
      ANTHROPIC_MODEL,
      generatedImageMicros,
    );

    return jsonResponse(
      {
        ok: true,
        talk_id: targetId,
        title,
        images: newlyGenerated,
        aids: visualAids.length,
        sections_locked: sectionsLocked,
      },
      200,
      cors,
    );
  } catch (e) {
    // withSentry only ever sees a throw that ESCAPES the handler, and this one
    // never does — so report it here, or nobody finds out this has been failing
    // since Tuesday. Then one plain sentence: String(e) hands whoever is
    // holding the phone a Postgres constraint name (CLAUDE.md).
    await reportCaughtError("generate-toolbox-talk", req, e);
    return jsonResponse({ error: UNEXPECTED_ERROR }, 500, cors);
  }
}));

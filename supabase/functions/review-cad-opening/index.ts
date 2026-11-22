import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { verifyCaller } from "../_shared/auth.ts";
import { corsHeaders, jsonResponse, requireOpenAI, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "../_shared/openai.ts";
import { parseJsonLoose } from "../_shared/anthropicJson.ts";
import { releaseAiSpend, reserveAiSpend, settleAiSpend } from "../_shared/spendGuard.ts";
import { reportCaughtError, withSentry } from "../_shared/sentry.ts";

import { CAD_VISION_MODEL as model, requestCadVision } from "../_shared/cadVision.ts";
import { CAD_DEFINITION_INSTRUCTIONS, CAD_REVIEW_INSTRUCTIONS, cadDefinitionContext, cadReviewContext, cleanCadDefinition } from "../_shared/cadReviewPrompt.mts";

type Candidate = { key: string; label: string };
const leadRoles = new Set(["foreman", "supervisor", "owner", "lead", "admin", "big_boss"]);
function crop(value: unknown) {
  if (typeof value !== "string" || value.length > 2_000_000 ||
      !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value)) return null;
  return value;
}

Deno.serve(withSentry("review-cad-opening", async req => {
  const cors = corsHeaders(req);
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { ...cors, "Cache-Control": "no-store" });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "POST required." }, 405);
  const auth = await verifyCaller(req);
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (auth.status !== "ok" || auth.user.id === "service_role" || !anon) return reply({ error: "Sign in as a foreman." }, 401);
  const body = await req.json().catch(() => null);
  const plan = crop(body?.planCrop);
  const candidates: Candidate[] = (Array.isArray(body?.candidates) ? body.candidates : []).slice(0, 80).filter((item: Candidate) =>
    item && typeof item.key === "string" && item.key.length <= 100 && typeof item.label === "string" && item.label.length <= 80)
    .map(({key,label}: Candidate) => ({key,label}));
  // Two questions share this function's sign-in, job and budget checks:
  // matching a plan opening to a drawing, and reading one drawing's own
  // definition (task "definition").
  const drawing = body?.task === "definition" ? crop(body.drawing) : null;
  if ((body?.task === "definition" ? !drawing : !plan || !candidates.length || typeof body.mark !== "string" || !/^[A-Z0-9-]{1,16}$/i.test(body.mark)) ||
      typeof body?.projectId !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(body.projectId)) {
    return reply({ error: drawing === null && body?.task === "definition" ? "A drawing crop and job are required." : "A plan crop, opening mark, job, and CAD choices are required." }, 400);
  }
  const caller = createClient(SUPABASE_URL, anon, { global: { headers: { Authorization: req.headers.get("Authorization")! } } });
  const [profile, project] = await Promise.all([
    caller.from("profiles").select("role,is_test").eq("id", auth.user.id).maybeSingle(),
    caller.from("projects").select("id").eq("id", body.projectId).is("deleted_at", null).maybeSingle(),
  ]);
  if (!profile.data || !leadRoles.has(profile.data.role) || !project.data) return reply({ error: "This job is unavailable for AI review." }, 403);
  if (profile.data.is_test && (await caller.rpc("is_sandbox_project", {p_project_id: body.projectId})).data !== true)
    return reply({ error: "TEST can review sandbox jobs only." }, 403);
  if (!SUPABASE_SERVICE_ROLE_KEY) return reply({ error: "AI review is unavailable." }, 503);
  try { requireOpenAI(); } catch { return reply({ error: "OpenAI review is unavailable." }, 503); }

  const meter = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const gate = await reserveAiSpend(meter, {
    functionName: "review-cad-opening", userId: auth.user.id,
    spendOverride: { kind: "content", provider: "openai", model, estimateMicros: 25000 },
  });
  if (!gate.allowed || !gate.reservationId) return reply({ error: "AI review budget is unavailable." }, 429);
  const evidence: { key: string; image: NonNullable<ReturnType<typeof crop>> }[] = [];
  for (const item of (Array.isArray(body.evidence) ? body.evidence : []).slice(0, 3)) {
    const image = crop(item?.image);
    if (image && candidates.some(candidate => candidate.key === item?.key)) evidence.push({key:item.key,image});
  }
  let usage: Parameters<typeof settleAiSpend>[2] = null;
  try {
    if (drawing) {
      const reading = await requestCadVision(CAD_DEFINITION_INSTRUCTIONS, cadDefinitionContext(body), [drawing]);
      usage = reading.usage;
      if (!reading.text) throw new Error(`OpenAI review failed: ${reading.failure}`);
      return reply({ ...cleanCadDefinition(parseJsonLoose(reading.text) as Record<string, unknown> | null), provider: "openai" });
    }
    const completion = await requestCadVision(
      CAD_REVIEW_INSTRUCTIONS,
      cadReviewContext(body, candidates, evidence.map(item => item.key)),
      [plan!, ...evidence.map(item => item.image)],
    );
    usage = completion.usage;
    if (!completion.text) throw new Error(`OpenAI review failed: ${completion.failure}`);
    const answer = parseJsonLoose(completion.text) as { key?: unknown; reason?: unknown } | null;
    const key = candidates.find(item => item.key === answer?.key)?.key ?? null;
    return reply({ key, reason: typeof answer?.reason === "string" ? answer.reason.slice(0, 400) : "AI could not establish a match.", provider: "openai" });
  } catch (error) {
    // Caught here, so withSentry never sees it; report it or it is invisible.
    await reportCaughtError("review-cad-opening", req, error);
    // The cause goes to the person too: a provider's reason or a timeout,
    // which is what tells a limit from an outage.
    const cause = error instanceof Error
      ? error.name === "TimeoutError" ? "timed out" : error.message.replace(/^OpenAI review failed: /, "")
      : "unknown";
    return reply({ error: `AI review could not complete (${cause.slice(0, 240)}).` }, 502);
  } finally {
    if (usage) await settleAiSpend(meter, gate.reservationId, usage, model);
    else await releaseAiSpend(meter, gate.reservationId, "review_failed", false);
  }
}));

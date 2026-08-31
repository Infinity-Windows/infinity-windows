// Vision placement: find WHERE each already-known schedule mark sits on a
// floor-plan page. Wave V-A ("the plans place their own windows").
//
// CAD-WINS, unchanged by this function: schedules own COUNTS, plans own
// PLACEMENT. This function never invents a mark and never counts one — it is
// handed the exact set of marks the schedule already knows about (one entry
// per still-unplaced opening) and does exactly one thing: find that mark's
// callout on the page and report where it is. A mark it cannot find is simply
// absent from `placements` — the caller decides what "not found" means, this
// function never guesses. A callout it CAN see whose text matches nothing on
// the given list is reported in `unknownMarks` instead of invented as a
// placement — the same rule cut both ways on the RAC-OAK-5 schedule read.
//
// Cloned from extract-schedule's vision path: anthropicVisionChat, one call
// per page, a single retry, pages batched 3 at a time, per-page failures
// reported rather than silently swallowed, and the same spend guard.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_MODEL,
  anthropicVisionChat,
  dataUrlToImage,
  requireAnthropic,
} from "../_shared/anthropic.ts";
import { verifyCaller } from "../_shared/auth.ts";
import { parseJsonLoose } from "../_shared/anthropicJson.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../_shared/spendGuard.ts";

/** One entry in the KNOWN-marks vocabulary fed to the model: an unplaced
 * opening's own code (already suffix-disambiguated by the schedule, e.g.
 * "13-1"/"13-2") and its type, for context only. */
interface KnownMark {
  code: string;
  type?: string | null;
}

/** A raw {mark, x, y, confidence} the model reported for one page, before the
 * known-marks allowlist below decides whether it is a placement or unknown. */
interface RawPlacement {
  mark: string;
  x: number;
  y: number;
  confidence: number | null;
}

/** Where the model found a mark's callout — always echoes a KNOWN mark's own
 * code exactly, never something the model made up. */
interface PlacementRow {
  mark: string;
  page: number;
  x: number;
  y: number;
  confidence: number;
}

/** A callout the page shows that matches no mark on the given list — reported,
 * never turned into an opening (CAD-WINS: plans place, they never create). */
interface UnknownMark {
  mark: string;
  page: number;
}

const VISION_SYSTEM =
  "You read ONE page of a FLOOR-PLAN from a residential/commercial window " +
  "and door planset. You are given the exact list of MARK codes this job's " +
  "schedule already knows about — each mark is a small circled or boxed " +
  "number/letter tag drawn next to a wall opening on the floor plan. " +
  "Your only job is to find where each given mark's tag is drawn ON THIS " +
  "PAGE and report its position. Rules, in priority order: " +
  "1. Only report a mark whose callout tag you can actually see on THIS " +
  "page. A mark from the list that is not on this page is simply left out " +
  "of your answer — never guess, never place it near a similar-looking tag. " +
  "2. x/y are the callout TAG's own position (the little circle/box with " +
  "the mark text in it, not the room, not the opening symbol), normalized " +
  "0..1 against the FULL page, origin top-left, x grows right, y grows down. " +
  "3. mark must be copied EXACTLY as given in the known-marks list below — " +
  "never invent a mark, never merge two marks, never strip or add a suffix " +
  "letter. " +
  "4. confidence is your own 0..1 estimate that this tag is genuinely that " +
  "mark (1 = printed plainly and unambiguous, lower when the tag is faint, " +
  "reused, or you are inferring from a nearby label). " +
  "5. If you see a callout tag on this page whose text does not match ANY " +
  "mark in the given list, report its printed text in unknownMarks instead " +
  "of guessing which known mark it might be. " +
  "6. Never report how many times a mark appears anywhere — counts are " +
  "already decided elsewhere; you are placing positions only, once per " +
  "callout you can see. " +
  'Reply with STRICT JSON only: { "placements": [ { "mark": string, ' +
  '"x": number, "y": number, "confidence": number } ], ' +
  '"unknownMarks": [ string ] }';

/** Normalize for allowlist matching: trim, uppercase, drop a leading '#'.
 * Deliberately simple (mirrors extract-schedule's cleanAndDedupe) — the model
 * is told to copy marks verbatim, so this only absorbs whitespace/case/# noise,
 * never fuzzy-matches a different mark into place. */
function normalizeMark(mark: string): string {
  return String(mark ?? "").trim().replace(/^#/, "").toUpperCase();
}

function cleanRawPlacements(raw: unknown): RawPlacement[] {
  if (!Array.isArray(raw)) return [];
  const out: RawPlacement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const mark = typeof o.mark === "string" ? o.mark : null;
    const x = Number(o.x);
    const y = Number(o.y);
    if (!mark || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    const confRaw = Number(o.confidence);
    const confidence = Number.isFinite(confRaw)
      ? Math.max(0, Math.min(1, confRaw))
      : 0.5;
    out.push({ mark, x, y, confidence });
  }
  return out;
}

function cleanUnknownMarks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, 100);
}

async function visionPlacementRead(
  images: { pageNumber: number; dataUrl: string }[],
  marks: KnownMark[],
  callerId: string | null,
  cors: Record<string, string>,
): Promise<Response> {
  const meter =
    SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
      : null;
  const capped = images.slice(0, 24);
  const gate = await reserveAiSpend(meter, {
    userId: callerId,
    functionName: "extract-placement",
    units: capped.length,
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
        placements: [],
        unknownMarks: [],
        failedPages: [],
        limited: true,
        limit_reason: gate.reason,
        note:
          "The company's monthly AI budget is used up, so this plan set " +
          "wasn't read for placements. An owner can raise the ceiling on " +
          "the AI spend screen and run Find placements again.",
      },
      200,
      cors,
    );
  }

  // The allowlist the model must match against, verbatim.
  const knownCodes = new Set(marks.map((m) => normalizeMark(m.code)));
  const marksHint = `Known marks on this job (match EXACTLY, do not invent):\n${JSON.stringify(
    marks.slice(0, 400).map((m) => ({ mark: m.code, type: m.type ?? undefined })),
  )}`;

  let inTokens = 0;
  let outTokens = 0;
  const failedPages: number[] = [];
  const placementsByKey = new Map<string, PlacementRow>();
  const unknownByKey = new Map<string, UnknownMark>();

  const readPage = async (img: { pageNumber: number; dataUrl: string }) => {
    const parsed = dataUrlToImage(img.dataUrl);
    if (!parsed) return;
    // Same reasoning as extract-schedule: anthropicVisionChat does not retry
    // on its own, and a silently-empty page here is a silently-unplaced mark
    // — the exact failure this function exists to avoid. One retry, then the
    // page is reported failed so the review tray can say so honestly.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await anthropicVisionChat({
          system: VISION_SYSTEM,
          text: `${marksHint}\n\nThis is page ${img.pageNumber} of the floor plan. Apply the rules and return the JSON.`,
          images: [parsed],
          maxTokens: 4096,
          onUsage: (u) => {
            inTokens += u?.inputTokens ?? 0;
            outTokens += u?.outputTokens ?? 0;
          },
        });
        const data = parseJsonLoose(reply) as
          | { placements?: unknown; unknownMarks?: unknown }
          | null;
        const rawPlacements = cleanRawPlacements(data?.placements);
        const rawUnknown = cleanUnknownMarks(data?.unknownMarks);

        // The allowlist is enforced HERE, in code, not just in the prompt —
        // CAD-WINS's "never invent" law cannot depend on the model obeying an
        // instruction. Anything the model returns that isn't an exact match
        // to a KNOWN mark demotes to unknown rather than becoming a placement.
        for (const p of rawPlacements) {
          const key = normalizeMark(p.mark);
          if (!knownCodes.has(key)) {
            const uKey = `${key}@${img.pageNumber}`;
            if (!unknownByKey.has(uKey)) {
              unknownByKey.set(uKey, { mark: p.mark.trim(), page: img.pageNumber });
            }
            continue;
          }
          const pKey = `${key}@${img.pageNumber}`;
          const existing = placementsByKey.get(pKey);
          if (!existing || p.confidence > existing.confidence) {
            placementsByKey.set(pKey, {
              mark: p.mark.trim(),
              page: img.pageNumber,
              x: p.x,
              y: p.y,
              confidence: p.confidence,
            });
          }
        }
        for (const raw of rawUnknown) {
          const key = normalizeMark(raw);
          if (knownCodes.has(key)) continue; // the model hedged; it does match
          const uKey = `${key}@${img.pageNumber}`;
          if (!unknownByKey.has(uKey)) {
            unknownByKey.set(uKey, { mark: raw, page: img.pageNumber });
          }
        }
        return;
      } catch (err) {
        console.error(
          "extract-placement vision page",
          img.pageNumber,
          "attempt",
          attempt + 1,
          err,
        );
        if (attempt === 0) await new Promise((res) => setTimeout(res, 2000));
      }
    }
    failedPages.push(img.pageNumber);
  };

  // Three pages at a time, same reasoning as extract-schedule: vision-sized
  // payloads burst-fired wide are a rate-limit magnet, and a lost page is a
  // lost placement.
  for (let i = 0; i < capped.length; i += 3) {
    await Promise.all(capped.slice(i, i + 3).map(readPage));
  }

  if (inTokens === 0 && outTokens === 0) {
    await releaseAiSpend(meter, gate.reservationId, "all_pages_failed", true);
  } else {
    await settleAiSpend(
      meter,
      gate.reservationId,
      { inputTokens: inTokens, outputTokens: outTokens },
      ANTHROPIC_MODEL,
    );
  }

  return jsonResponse(
    {
      placements: [...placementsByKey.values()],
      unknownMarks: [...unknownByKey.values()],
      failedPages,
      mode: "vision",
    },
    200,
    cors,
  );
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
    requireAnthropic();
    const body = await req.json().catch(() => ({}));
    const images = Array.isArray(body.images)
      ? (body.images as { pageNumber: number; dataUrl: string }[]).filter(
          (i) => i && typeof i.dataUrl === "string" && Number.isFinite(Number(i.pageNumber)),
        )
      : [];
    const marks = Array.isArray(body.marks)
      ? (body.marks as KnownMark[]).filter(
          (m) => m && typeof m.code === "string" && m.code.trim(),
        )
      : [];
    if (images.length === 0) {
      return jsonResponse({ error: "images[] required" }, 400, cors);
    }
    if (marks.length === 0) {
      // Nothing to look for. Not an error — every opening on this job is
      // already placed, or the schedule hasn't been read yet — but there is
      // no vision call worth making.
      return jsonResponse(
        { placements: [], unknownMarks: [], failedPages: [], mode: "vision" },
        200,
        cors,
      );
    }

    return await visionPlacementRead(images, marks, callerId, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

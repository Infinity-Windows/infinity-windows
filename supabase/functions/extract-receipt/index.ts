// Wave P, P2: read a snapped receipt with Claude vision. Mirrors extract-
// specs' auth/spend-guard shape (verifyCaller, reserveAiSpend/settleAiSpend/
// releaseAiSpend) and, for the vision call itself, transcribe-install-memo's
// download-then-base64 pattern (storage.download → bytesToBase64 →
// AnthropicImage), since a receipt photo is one already-uploaded object
// rather than several client-rendered page images.
//
// This function is READ-ONLY against the database: it never writes a
// receipts row itself. It returns the raw reading, and the CLIENT calls
// apply_receipt_extraction (20260960000000_receipts.sql) with its own
// session to persist it — the same "edge function computes, client writes"
// split extract-specs uses (see that file's own header comment: "the client
// does the deterministic decode and final normalization/merge"). Two
// reasons this matters more here than there: apply_receipt_extraction's
// fill-missing-only guard has to be enforced by ONE atomic SQL statement to
// be race-safe against a human editing the same row at the same moment
// (THE LAW — see that function's comment), and its "uploader-or-supervisor"
// authorization is exactly the caller's own floor, which falls out for free
// when the caller's own JWT makes the RPC call instead of this function
// reaching for a service-role client.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  corsHeaders,
  jsonResponse,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "../_shared/openai.ts";
import {
  ANTHROPIC_MODEL,
  anthropicChatJson,
  requireAnthropic,
  type AnthropicImage,
  type AnthropicUsage,
} from "../_shared/anthropic.ts";
import type { JsonSchema } from "../_shared/anthropicJson.ts";
import { callerSupabaseClient, verifyCaller } from "../_shared/auth.ts";
import { bytesToBase64 } from "../_shared/bytes.ts";
import {
  notifyOwnersOfSpend,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
  type SpendVerdict,
} from "../_shared/spendGuard.ts";
import {
  receiptFullyFilled,
  type ReceiptCategory,
  type ReceiptExtractableFields,
} from "../_shared/receiptMerge.ts";

interface LineItem {
  description: string;
  amount_cents: number | null;
}

/** What the model returns — the raw reading, before any merge. */
export interface RawReceiptExtraction {
  amount_cents: number | null;
  vendor: string | null;
  purchased_on: string | null;
  category: ReceiptCategory | null;
  line_items: LineItem[];
}

const SYSTEM =
  "You read a photo of a purchase receipt for a window/door install crew. " +
  "Report the total amount, the vendor/store name, the purchase date, a " +
  "best-guess category, and the line items you can make out. Use null for " +
  "anything the photo does not show clearly — never invent a number. Return " +
  "STRICT JSON only, no prose, no markdown fences.";

const SCHEMA_HINT =
  'Schema: { "amount_cents": integer|null, "vendor": string|null, ' +
  '"purchased_on": string|null, "category": "gas"|"other"|null, ' +
  '"line_items": [ { "description": string, "amount_cents": integer|null } ] }. ' +
  "amount_cents is the TOTAL in cents (e.g. $12.50 -> 1250). purchased_on is " +
  'the date printed on the receipt as YYYY-MM-DD, or null if unreadable. ' +
  'category is "gas" only for a fuel-station purchase; everything else ' +
  '(materials, hardware, tools, food, lodging) is "other". line_items is the ' +
  "itemized list if the receipt shows one, else an empty array — never omit it.";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    amount_cents: { type: ["integer", "null"] },
    vendor: { type: ["string", "null"] },
    purchased_on: { type: ["string", "null"] },
    category: { type: ["string", "null"], enum: ["gas", "other", null] },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          amount_cents: { type: ["integer", "null"] },
        },
      },
    },
  },
};

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function dateOrNull(v: unknown): string | null {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function categoryOrNull(v: unknown): ReceiptCategory | null {
  return v === "gas" || v === "other" ? v : null;
}

function cleanExtraction(raw: unknown): RawReceiptExtraction {
  const o = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(o.line_items) ? o.line_items : [];
  return {
    amount_cents: numOrNull(o.amount_cents),
    vendor: str(o.vendor),
    purchased_on: dateOrNull(o.purchased_on),
    category: categoryOrNull(o.category),
    line_items: items
      .map((it) => {
        const r = (it ?? {}) as Record<string, unknown>;
        const description = str(r.description);
        return description ? { description, amount_cents: numOrNull(r.amount_cents) } : null;
      })
      .filter((it): it is LineItem => it !== null),
  };
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
    const receiptId = str(body.receiptId);
    const force = body.force === true;
    if (!receiptId) {
      return jsonResponse({ error: "receiptId is required" }, 400, cors);
    }

    // Read as the CALLER, not the service role — the same select policy that
    // gates the receipts feed (foreman+, or the uploader reading their own)
    // gates whether this function will even look at the row. A caller who
    // cannot see the receipt gets exactly what a direct REST read would give
    // them: nothing.
    const caller = callerSupabaseClient(req);
    if (!caller) {
      return jsonResponse({ error: "unauthorized" }, 401, cors);
    }
    const { data: receiptRow, error: receiptErr } = await caller
      .from("receipts")
      .select("photo_path, amount_cents, vendor, purchased_on, category, category_by")
      .eq("id", receiptId)
      .maybeSingle();
    if (receiptErr) {
      return jsonResponse({ error: receiptErr.message }, 400, cors);
    }
    if (!receiptRow) {
      return jsonResponse({ error: "no such receipt" }, 404, cors);
    }
    const current = receiptRow as unknown as ReceiptExtractableFields & { photo_path: string };

    // Spend-conscious default (docs/ai-spend-limits.md): a receipt that is
    // already fully read costs nothing to skip, and "the office hit Re-scan
    // on a receipt someone already filled in by hand" is common enough to be
    // worth catching before a single token is spent.
    if (!force && receiptFullyFilled(current)) {
      return jsonResponse(
        { ok: true, skipped: true, reason: "already fully read", extraction: null },
        200,
        cors,
      );
    }

    const meter =
      SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
        ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        : null;
    const gate: SpendVerdict = await reserveAiSpend(meter, {
      userId: callerId,
      functionName: "extract-receipt",
      units: 1,
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
          extraction: null,
          note:
            "The company's monthly AI budget is used up, so this receipt wasn't read automatically. It still saved — an owner can raise the ceiling on the AI spend screen and re-scan it.",
        },
        200,
        cors,
      );
    }

    const slash = current.photo_path.indexOf("/");
    const bucket = slash >= 0 ? current.photo_path.slice(0, slash) : "install-media";
    const key = slash >= 0 ? current.photo_path.slice(slash + 1) : current.photo_path;
    const { data: blob, error: downloadErr } = await caller.storage.from(bucket).download(key);
    if (downloadErr || !blob) {
      await releaseAiSpend(meter, gate.reservationId, "photo_download_failed", true);
      return jsonResponse({ error: "could not read the receipt photo" }, 502, cors);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const image: AnthropicImage = {
      mediaType: blob.type || "image/jpeg",
      data: bytesToBase64(bytes),
    };

    let usage: AnthropicUsage = { inputTokens: 0, outputTokens: 0 };
    let extraction: RawReceiptExtraction;
    try {
      const raw = await anthropicChatJson<Record<string, unknown>>({
        system: SYSTEM,
        user: "Here is the receipt photo. Return the JSON now.",
        schemaHint: SCHEMA_HINT,
        schema: SCHEMA,
        images: [image],
        model: ANTHROPIC_MODEL,
        maxTokens: 1024,
        onUsage: (u) => {
          usage = u;
        },
      });
      extraction = cleanExtraction(raw);
    } catch (err) {
      await releaseAiSpend(meter, gate.reservationId, "no_provider_response", true);
      console.error("extract-receipt vision call failed", err);
      return jsonResponse({ error: "could not read the receipt" }, 502, cors);
    }

    await settleAiSpend(meter, gate.reservationId, usage, ANTHROPIC_MODEL);

    return jsonResponse({ ok: true, skipped: false, extraction }, 200, cors);
  } catch (e) {
    console.error(e);
    return jsonResponse({ error: String(e) }, 500, cors);
  }
});

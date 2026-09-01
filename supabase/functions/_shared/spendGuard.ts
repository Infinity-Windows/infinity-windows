/**
 * The spend guard every paid AI call goes through. Deno runtime.
 *
 * The decision itself is NOT made here — it is made in one SQL statement by
 * `ai_spend_reserve` (see supabase/migrations/…_ai_spend_limits.sql), because
 * the runaway this protects against is rapid fire and a read-then-write check in
 * TypeScript would lose exactly when it matters. This module is the seam: it
 * prices a call, asks the database for permission, and reconciles the estimate
 * against the token counts the provider actually returned.
 *
 * Two rules shape everything below:
 *
 *  1. FAIL OPEN on plumbing, FAIL CLOSED on money. If the RPC is missing (a
 *     migration hasn't been applied yet) or the service-role key isn't in the
 *     environment, the guard allows the call — a metering outage must never take
 *     the assistant offline. If the RPC answers "no", the answer is no.
 *
 *  2. NEVER THROW. A guard that can throw becomes a new failure mode for the
 *     feature it protects.
 */

/** What the caller is spending money on. See the migration for why they differ. */
export type SpendKind = "question" | "content";

export type DenyReason = "role" | "user_daily" | "monthly_cap";

export interface SpendVerdict {
  allowed: boolean;
  reason: DenyReason | null;
  /** Pass to {@link settleAiSpend} / {@link releaseAiSpend}. Null when unmetered. */
  reservationId: string | null;
  /** Short, plain-English line for the person who was refused. */
  note: string | null;
  /** 'warn' | 'cap' on the single call that crossed the threshold, else null. */
  alert: "warn" | "cap" | null;
  /** Who to tell about that threshold. Empty unless `alert` is set. */
  alertProfileIds: string[];
  callsToday: number | null;
  dailyLimit: number | null;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------
// Micro-dollars (millionths of a dollar) per token, so the interesting small
// numbers survive: synthesising tips for one window type costs $0.0009, which
// rounds to zero in cents. Figures from docs/ask-infinity-token-free.md Part 5,
// checked 29 July 2026. Claude's $2/$10 is introductory until 31 Aug 2026 and
// becomes $3/$15 — update the two numbers here when it does; nothing else moves.
interface ModelPrice {
  inPerToken: number;
  outPerToken: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-sonnet-5": { inPerToken: 2, outPerToken: 10 },
  "gpt-4o-mini": { inPerToken: 0.15, outPerToken: 0.6 },
  "gpt-4o": { inPerToken: 2.5, outPerToken: 10 },
  "text-embedding-3-small": { inPerToken: 0.02, outPerToken: 0 },
};

/** Anything not in the table is priced as the most expensive model we use, so a
 * new/unknown model can never look free. */
const FALLBACK_PRICE: ModelPrice = { inPerToken: 3, outPerToken: 15 };

/** Cost of a call in micro-dollars, from the provider's own token counts. */
export function costMicros(
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number {
  const price = MODEL_PRICES[model] ?? FALLBACK_PRICE;
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  return Math.round(inTok * price.inPerToken + outTok * price.outPerToken);
}

/** A flat image-generation charge (gpt-image-1, 1024x1024) in micro-dollars. */
export const IMAGE_MICROS = 40_000;

// ---------------------------------------------------------------------------
// Per-function estimates, booked before the call and reconciled after
// ---------------------------------------------------------------------------
// The estimate matters for one reason: the monthly ceiling is tested against
// money already *booked*, not money already *spent*. Fifty calls in flight have
// each booked their estimate, so the fifty-first is measured against them rather
// than against a total that will not exist until they all return.
export interface FunctionSpend {
  kind: SpendKind;
  provider: "anthropic" | "openai";
  model: string;
  /** Estimated micro-dollars for one invocation. */
  estimateMicros: number;
}

export const FUNCTION_SPEND: Record<string, FunctionSpend> = {
  // 12k tokens in / 300 out on Claude = 2.7 cents, the exact figure the
  // investigation costed the runaway on.
  ask: {
    kind: "question",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 27_000,
  },
  // One short completion on Claude plus up to two OpenAI diagrams. The images
  // are still the cost, not the words: 8 cents of picture, 1.3 of writing.
  "generate-toolbox-talk": {
    kind: "question",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 13_000 + 2 * IMAGE_MICROS,
  },
  // Claude vision + text over a whole specs planset, several calls deep.
  "extract-specs": {
    kind: "content",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 50_000,
  },
  // Per BATCH — `units` is the batch count — of ~22k tokens of planset text,
  // now on Claude: 22k in at $2/M plus ~3k out at $10/M.
  "extract-schedule": {
    kind: "content",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 74_000,
  },
  // Was $0.0009 a window type on gpt-4o-mini; the same 2k-in/1k-out call on
  // Claude is $0.014. Text generation moved provider, so these figures had to
  // move with it — otherwise the owner's spend screen reports a number the
  // company is not actually being charged.
  "synthesize-type-tips": {
    kind: "content",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 14_000,
  },
  "generate-howto": {
    kind: "content",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 14_000,
  },
  // Whisper on a ~2 minute memo (1.2 cents, still OpenAI and charged on top as
  // extra micros) plus a Claude vision pass over up to four job photos.
  "transcribe-install-memo": {
    kind: "content",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 20_000,
  },
  // A person tapping a button, same as `ask` — question-kind, so it shares
  // Ask Infinity's per-user daily count rather than getting its own. The
  // simplified model JSON is capped at ~8KB (~2k tokens) client-side; add the
  // system prompt, catalog summary and question and call it 3k tokens in.
  // Replies are short, occasionally with an add_unit JSON block: ~400 out.
  "studio-assist": {
    kind: "question",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 10_000,
  },
  // Embeddings only: $0.02 per million tokens. Effectively free, metered anyway
  // so the owner screen can never have a blind spot.
  "ingest-knowledge": {
    kind: "content",
    provider: "openai",
    model: "text-embedding-3-small",
    estimateMicros: 500,
  },
  // One small compressed receipt photo (1280px/0.82 JPEG) + a short JSON
  // reply — one image, one call, nowhere near extract-specs' multi-page
  // planset. Content-kind like extract-specs: any signed-in crew member can
  // trigger it (Q, wave P) by snapping a receipt, so it carries no role
  // floor, only the metered ceiling.
  "extract-receipt": {
    kind: "content",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 8_000,
  },
  // Per PAGE (`units` is the floor-plan page count) — a smaller structured
  // reply than extract-schedule's page read (positions for known marks, not
  // full row transcription), so priced a step below it.
  "extract-placement": {
    kind: "content",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 40_000,
  },
  // A lesson transcript in, a summary plus 5 structured MC questions out —
  // more structured output than generate-howto's plain prose, so priced a
  // step above it. The transcribe action (Whisper, on our own stored file)
  // shares this same booking and is reconciled to its real cost afterward,
  // exactly like transcribe-install-memo's whisperMicros.
  "summarize-learning-video": {
    kind: "content",
    provider: "anthropic",
    model: "claude-sonnet-5",
    estimateMicros: 18_000,
  },
};

// ---------------------------------------------------------------------------
// The notes a refused person sees
// ---------------------------------------------------------------------------
// Written for an installer standing at an opening, not for an engineer. None of
// them say "error", none of them mention money to a crew member, and all of
// them tell the reader that the answer they are about to get is still real.
/** English, not string concatenation: "foremans" would be the first thing an
 * installer noticed about this feature. */
const ROLE_PLURALS: Record<string, string> = {
  installer: "installers",
  foreman: "foremen",
  supervisor: "supervisors",
  owner: "owners",
};

export function denialNote(reason: DenyReason, minRole = "foreman"): string {
  switch (reason) {
    case "role":
      return `Answered from the company brain. The AI assistant is for ${ROLE_PLURALS[minRole] ?? minRole} and above — everything below comes from your company's own written notes.`;
    case "user_daily":
      return "Answered from the company brain. You've used today's AI questions, so this one came out of the company's own notes instead. It resets in the morning.";
    case "monthly_cap":
      return "Answered from the company brain. The company's AI budget for this month is used up — the office has been told. Your answer below still comes from the company's own notes.";
  }
}

/**
 * Just enough of the Supabase client to move the meter. Described structurally
 * rather than imported, so this module stays runtime-agnostic and the browser
 * test suite can exercise it with a two-line fake. `PromiseLike` rather than
 * `Promise` because supabase-js returns a thenable query builder, not a promise.
 */
export interface RpcClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
}

const ALLOW_UNMETERED: SpendVerdict = {
  allowed: true,
  reason: null,
  reservationId: null,
  note: null,
  alert: null,
  alertProfileIds: [],
  callsToday: null,
  dailyLimit: null,
};

export interface ReserveInput {
  /** The end user, or null for a service-role / webhook caller. */
  userId: string | null;
  functionName: keyof typeof FUNCTION_SPEND | string;
  /** Multiply the per-invocation estimate (e.g. one call per window type). */
  units?: number;
  /** Override the registry's kind. Rarely needed. */
  kind?: SpendKind;
}

/**
 * Ask the database for permission and book the estimate. Fails open when the
 * database can't answer — see rule 1 at the top of this file.
 */
export async function reserveAiSpend(
  client: RpcClient | null,
  input: ReserveInput,
): Promise<SpendVerdict> {
  if (!client) return ALLOW_UNMETERED;
  const spend = FUNCTION_SPEND[input.functionName];
  const kind = input.kind ?? spend?.kind ?? "question";
  const units = Math.max(1, Math.floor(input.units ?? 1));
  const estimate = (spend?.estimateMicros ?? 0) * units;

  try {
    const { data, error } = await client.rpc("ai_spend_reserve", {
      p_user_id: input.userId,
      p_function: input.functionName,
      p_kind: kind,
      p_estimate_micros: estimate,
      p_provider: spend?.provider ?? null,
      p_model: spend?.model ?? null,
    });
    if (error || !data || typeof data !== "object") {
      console.warn("ai spend guard unavailable, allowing call", error);
      return ALLOW_UNMETERED;
    }
    return readVerdict(data as Record<string, unknown>);
  } catch (e) {
    console.warn("ai spend guard threw, allowing call", e);
    return ALLOW_UNMETERED;
  }
}

/** Shape the RPC's jsonb verdict, tolerating anything unexpected. */
export function readVerdict(row: Record<string, unknown>): SpendVerdict {
  const allowed = row.allowed === true;
  const rawReason = typeof row.reason === "string" ? row.reason : null;
  const reason =
    rawReason === "role" || rawReason === "user_daily" || rawReason === "monthly_cap"
      ? rawReason
      : null;
  const minRole = typeof row.min_role === "string" ? row.min_role : "foreman";
  const alertRaw = typeof row.alert === "string" ? row.alert : null;
  const alert = alertRaw === "warn" || alertRaw === "cap" ? alertRaw : null;
  return {
    allowed,
    reason: allowed ? null : reason,
    reservationId:
      typeof row.reservation_id === "string" ? row.reservation_id : null,
    note: !allowed && reason ? denialNote(reason, minRole) : null,
    alert,
    alertProfileIds: alert
      ? (Array.isArray(row.alert_profile_ids) ? row.alert_profile_ids : []).filter(
          (id): id is string => typeof id === "string",
        )
      : [],
    callsToday: typeof row.calls_today === "number" ? row.calls_today : null,
    dailyLimit: typeof row.daily_limit === "number" ? row.daily_limit : null,
  };
}

/** Replace the booked estimate with what the provider actually charged. */
export async function settleAiSpend(
  client: RpcClient | null,
  reservationId: string | null,
  usage: TokenUsage | null,
  model: string,
  extraMicros = 0,
): Promise<void> {
  if (!client || !reservationId) return;
  const micros =
    costMicros(model, usage?.inputTokens, usage?.outputTokens) +
    Math.max(0, extraMicros);
  try {
    await client.rpc("ai_spend_settle", {
      p_event_id: reservationId,
      p_input_tokens: usage?.inputTokens ?? null,
      p_output_tokens: usage?.outputTokens ?? null,
      p_cost_micros: micros,
      p_model: model,
    });
  } catch (e) {
    console.warn("ai spend settle failed", e);
  }
}

/**
 * Give the reservation back. Money is always refunded; the call COUNT is
 * refunded only when we never reached the provider (`refundCall`). A provider
 * failure keeps the count on purpose: a client stuck retrying is exactly the
 * runaway being defended against, and it must still run out of quota.
 */
export async function releaseAiSpend(
  client: RpcClient | null,
  reservationId: string | null,
  reason: string,
  refundCall = false,
): Promise<void> {
  if (!client || !reservationId) return;
  try {
    await client.rpc("ai_spend_release", {
      p_event_id: reservationId,
      p_reason: reason,
      p_refund_call: refundCall,
    });
  } catch (e) {
    console.warn("ai spend release failed", e);
  }
}

/**
 * Tell the owner, now, that the budget is in trouble.
 *
 * Channel choice: this rides the app's existing web-push path (`send-push`,
 * already deployed with VAPID keys) rather than Slack. The Slack wiring in this
 * repo is a CI failure notifier — it runs in GitHub Actions, and reaching it
 * from a running edge function would mean adding a webhook secret that is not
 * there today. Push is already set up, already reaches the owner's phone with
 * the app closed, and lands next to every other alert they get from the
 * business. The durable record is the `ai_spend_alerts` row, which the owner
 * screen reads, so the notification is a convenience and never the only trace.
 *
 * Best-effort and silent on failure: an alert must never break the request.
 */
export async function notifyOwnersOfSpend(
  level: "warn" | "cap",
  profileIds: string[],
  env: { supabaseUrl: string; serviceRoleKey: string },
): Promise<void> {
  if (!env.supabaseUrl || !env.serviceRoleKey) return;
  if (profileIds.length === 0) return;
  try {
    const body =
      level === "cap"
        ? "The monthly AI budget is used up. Crew are still getting answers from the company brain. Raise the ceiling on the AI spend screen if you want the assistant back."
        : "The monthly AI budget is most of the way used. Nothing is blocked yet.";

    await fetch(`${env.supabaseUrl}/functions/v1/send-push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        profileIds,
        title: level === "cap" ? "AI budget reached" : "AI budget at 80%",
        body,
        tag: `ai-spend-${level}`,
        url: "/ai-spend",
      }),
    });
  } catch (e) {
    console.warn("ai spend owner notification failed", e);
  }
}

import { describe, expect, it, vi } from "vitest";
import {
  costMicros,
  denialNote,
  FUNCTION_SPEND,
  IMAGE_MICROS,
  MODEL_PRICES,
  readVerdict,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} from "../../../supabase/functions/_shared/spendGuard.ts";

// The figures asserted here are the ones docs/ask-infinity-token-free.md costed
// the runaway on, so if a price moves the test says which number moved.
describe("costMicros", () => {
  it("prices a real Ask question at 2.7 cents", () => {
    // 12,000 tokens in and 300 out on Claude, the shape the investigation
            // measured: $2/M in, $10/M out.
    expect(costMicros("claude-sonnet-5", 12_000, 300)).toBe(27_000);
  });

  it("prices one window type's tips at $0.0009", () => {
    // gpt-4o-mini at $0.15/M in, $0.60/M out.
    expect(costMicros("gpt-4o-mini", 2_000, 1_000)).toBe(900);
  });

  it("prices the whole 102-type catalog at about 9 cents", () => {
    const perType = costMicros("gpt-4o-mini", 2_000, 1_000);
    expect(perType * 102).toBeGreaterThan(85_000);
    expect(perType * 102).toBeLessThan(100_000);
  });

  it("never treats an unknown model as free", () => {
    expect(costMicros("some-new-model-2027", 1_000, 1_000)).toBe(18_000);
  });

  it("treats missing token counts as zero rather than NaN", () => {
    expect(costMicros("claude-sonnet-5", null, undefined)).toBe(0);
  });
});

describe("the runaway the cap exists to stop", () => {
  it("costs $79 for a day of tapping send every ten seconds", () => {
    const callsInAnEightHourDay = (8 * 60 * 60) / 10; // 2,880
    const dollars =
      (callsInAnEightHourDay * costMicros("claude-sonnet-5", 12_000, 300)) /
      1_000_000;
    expect(Math.round(dollars)).toBe(78);
  });

  it("is capped at about a dollar a day per account by the default daily limit", () => {
    const dollars = (40 * costMicros("claude-sonnet-5", 12_000, 300)) / 1_000_000;
    expect(dollars).toBeCloseTo(1.08, 2);
  });
});

describe("FUNCTION_SPEND", () => {
  it("treats crew questions and safety talks as read-time, everything else as write-time", () => {
    const questions = Object.entries(FUNCTION_SPEND)
      .filter(([, v]) => v.kind === "question")
      .map(([k]) => k)
      .sort();
    expect(questions).toEqual(["ask", "generate-toolbox-talk", "studio-assist"]);
  });

  it("estimates Ask at exactly the investigation's per-question cost", () => {
    expect(FUNCTION_SPEND.ask.estimateMicros).toBe(
      costMicros("claude-sonnet-5", 12_000, 300),
    );
  });

  it("makes the safety talk's two diagrams the bulk of its estimate", () => {
    expect(FUNCTION_SPEND["generate-toolbox-talk"].estimateMicros).toBeGreaterThan(
      2 * IMAGE_MICROS,
    );
  });

  it("gives every metered function a non-zero estimate", () => {
    for (const [name, spend] of Object.entries(FUNCTION_SPEND)) {
      expect(spend.estimateMicros, name).toBeGreaterThan(0);
    }
  });

  // Text generation moved from OpenAI to Claude, and Claude costs about
  // thirteen times more per word than gpt-4o-mini did. If a function's provider
  // and its price tag ever disagree, the owner's spend screen reports money the
  // company is not being charged — or misses money it is.
  it("prices everything except embeddings as Claude", () => {
    const openai = Object.entries(FUNCTION_SPEND)
      .filter(([, v]) => v.provider === "openai")
      .map(([k]) => k)
      .sort();
    expect(openai).toEqual(["ingest-knowledge"]);
  });

  it("uses a model whose price we actually know for every function", () => {
    for (const [name, spend] of Object.entries(FUNCTION_SPEND)) {
      expect(Object.keys(MODEL_PRICES), name).toContain(spend.model);
    }
  });

  it("estimates a window type's tips and one how-to at Claude's price, not the old one", () => {
    // 2k tokens in, 1k out — the same call the write-time table costed at
    // $0.0009 on gpt-4o-mini, which is $0.014 on Claude.
    const claudePerType = costMicros("claude-sonnet-5", 2_000, 1_000);
    expect(claudePerType).toBe(14_000);
    expect(FUNCTION_SPEND["synthesize-type-tips"].estimateMicros).toBe(claudePerType);
    expect(FUNCTION_SPEND["generate-howto"].estimateMicros).toBe(claudePerType);
  });

  it("keeps a big planset's whole read under a dollar", () => {
    // 12 batches is the cap in extract-schedule, and `units` multiplies the
    // per-batch estimate. Worth pinning: this is the priciest thing in the app
    // and the one most changed by the move to Claude.
    const worstCase = FUNCTION_SPEND["extract-schedule"].estimateMicros * 12;
    expect(worstCase).toBeLessThan(1_000_000);
  });
});

describe("denialNote", () => {
  it("tells a refused installer the answer is still real, and never says 'error'", () => {
    for (const reason of ["role", "user_daily", "monthly_cap"] as const) {
      const note = denialNote(reason);
      expect(note.toLowerCase()).not.toContain("error");
      expect(note).toContain("company");
    }
  });

  it("never mentions money to a crew member who is out of questions", () => {
    expect(denialNote("user_daily")).not.toMatch(/\$|budget/);
  });

  it("names the role floor it was given, in English", () => {
    expect(denialNote("role", "supervisor")).toContain("supervisors and above");
    expect(denialNote("role", "foreman")).toContain("foremen and above");
    expect(denialNote("role", "foreman")).not.toContain("foremans");
  });
});

describe("readVerdict", () => {
  it("carries a refusal's reason and a note", () => {
    const v = readVerdict({
      allowed: false,
      reason: "user_daily",
      reservation_id: "abc",
      daily_limit: 40,
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("user_daily");
    expect(v.note).toContain("resets in the morning");
    expect(v.dailyLimit).toBe(40);
  });

  it("does not invent a reason on an allowed call", () => {
    const v = readVerdict({ allowed: true, reason: null, calls_today: 3 });
    expect(v.reason).toBeNull();
    expect(v.note).toBeNull();
    expect(v.callsToday).toBe(3);
  });

  it("ignores a reason it does not recognise rather than trusting it", () => {
    const v = readVerdict({ allowed: false, reason: "because I said so" });
    expect(v.reason).toBeNull();
    expect(v.note).toBeNull();
  });

  it("surfaces a threshold crossing exactly as given", () => {
    expect(readVerdict({ allowed: true, alert: "cap" }).alert).toBe("cap");
    expect(readVerdict({ allowed: true, alert: "nonsense" }).alert).toBeNull();
  });

  it("carries the owners to tell, but only on the call that crossed the line", () => {
    // Verbatim shape from a live ai_spend_reserve at 80% of the ceiling.
    const crossed = readVerdict({
      allowed: true,
      alert: "warn",
      alert_profile_ids: [
        "958d3bfc-946e-46b3-a84c-a84d5f586a2e",
        "4d8f7c12-21bc-4b69-9993-2928dc097ac2",
      ],
    });
    expect(crossed.alertProfileIds).toHaveLength(2);

    // Every other call carries nobody, so the owner is pushed once, not 40 times.
    const quiet = readVerdict({
      allowed: true,
      alert: null,
      alert_profile_ids: ["958d3bfc-946e-46b3-a84c-a84d5f586a2e"],
    });
    expect(quiet.alertProfileIds).toEqual([]);
  });

  it("drops anything that isn't an id rather than passing it to the push", () => {
    const v = readVerdict({ allowed: true, alert: "cap", alert_profile_ids: [1, null, "ok"] });
    expect(v.alertProfileIds).toEqual(["ok"]);
  });
});

describe("reserveAiSpend fails open on plumbing and closed on money", () => {
  it("allows the call when there is no database to ask", async () => {
    const v = await reserveAiSpend(null, { userId: "u1", functionName: "ask" });
    expect(v.allowed).toBe(true);
    expect(v.reservationId).toBeNull();
  });

  it("allows the call when the RPC is missing (migration not applied yet)", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'function public.ai_spend_reserve does not exist' },
      }),
    };
    const v = await reserveAiSpend(client, { userId: "u1", functionName: "ask" });
    expect(v.allowed).toBe(true);
  });

  it("allows the call when the RPC throws", async () => {
    const client = { rpc: vi.fn().mockRejectedValue(new Error("network")) };
    expect((await reserveAiSpend(client, { userId: "u1", functionName: "ask" })).allowed).toBe(
      true,
    );
  });

  it("refuses when the database says no", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: { allowed: false, reason: "monthly_cap", reservation_id: "r1" },
        error: null,
      }),
    };
    const v = await reserveAiSpend(client, { userId: "u1", functionName: "ask" });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("monthly_cap");
  });

  it("books one estimate per unit of work, so a 12-page planset books 12", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { allowed: true, reason: null }, error: null });
    await reserveAiSpend({ rpc }, {
      userId: "u1",
      functionName: "extract-specs",
      units: 12,
    });
    expect(rpc.mock.calls[0][1].p_estimate_micros).toBe(
      12 * FUNCTION_SPEND["extract-specs"].estimateMicros,
    );
    expect(rpc.mock.calls[0][1].p_kind).toBe("content");
  });

  it("sends a null user for a service-role caller so no personal quota is charged", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { allowed: true, reason: null }, error: null });
    await reserveAiSpend({ rpc }, {
      userId: null,
      functionName: "transcribe-install-memo",
    });
    expect(rpc.mock.calls[0][1].p_user_id).toBeNull();
  });
});

describe("settle and release", () => {
  it("settles with the provider's real token counts, not the estimate", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await settleAiSpend({ rpc }, "r1", { inputTokens: 900, outputTokens: 120 }, "gpt-4o-mini");
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_event_id: "r1",
      p_input_tokens: 900,
      p_output_tokens: 120,
      p_cost_micros: costMicros("gpt-4o-mini", 900, 120),
    });
  });

  it("adds a flat charge for work the provider does not bill in tokens", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await settleAiSpend({ rpc }, "r1", { inputTokens: 0, outputTokens: 0 }, "gpt-4o-mini", 2 * IMAGE_MICROS);
    expect(rpc.mock.calls[0][1].p_cost_micros).toBe(2 * IMAGE_MICROS);
  });

  it("does nothing at all when there was no reservation", async () => {
    const rpc = vi.fn();
    await settleAiSpend({ rpc }, null, { inputTokens: 1, outputTokens: 1 }, "gpt-4o");
    await releaseAiSpend({ rpc }, null, "whatever");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("keeps the call count on a provider failure, so a retry loop still runs out", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await releaseAiSpend({ rpc }, "r1", "provider_failed", false);
    expect(rpc.mock.calls[0][1].p_refund_call).toBe(false);
  });

  it("gives the count back when we never reached the provider", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await releaseAiSpend({ rpc }, "r1", "provider_unconfigured", true);
    expect(rpc.mock.calls[0][1].p_refund_call).toBe(true);
  });

  it("never throws when settling fails", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("gone"));
    await expect(
      settleAiSpend({ rpc }, "r1", { inputTokens: 1, outputTokens: 1 }, "gpt-4o"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The property that actually matters
// ---------------------------------------------------------------------------
// The runaway is rapid fire, so the limiter has to hold when many calls overlap.
// These two fakes model the two ways of writing the check. `atomic` mirrors the
// `insert … on conflict do update … where` in the migration: the read and the
// write are one indivisible step. `naive` mirrors a read-then-write check, which
// is what a client-side guard or a two-statement server guard reduces to. The
// interleaved run below is the whole argument for putting the decision in SQL.
function atomicLimiter(limit: number) {
  let calls = 0;
  return {
    // One step: bump and test together, exactly as the SQL statement does.
    reserve: async () => {
      if (calls >= limit) return { allowed: false as const };
      calls += 1;
      return { allowed: true as const };
    },
    count: () => calls,
  };
}

function naiveLimiter(limit: number) {
  let calls = 0;
  return {
    // Two steps with an await between them — a scheduling gap another caller
    // can slip into, which is what happens over a real network.
    reserve: async () => {
      const seen = calls;
      await Promise.resolve();
      if (seen >= limit) return { allowed: false as const };
      calls += 1;
      return { allowed: true as const };
    },
    count: () => calls,
  };
}

describe("the daily limit under rapid fire", () => {
  it("lets exactly 40 through and refuses the rest, one after another", async () => {
    const limiter = atomicLimiter(40);
    const results = [];
    for (let i = 0; i < 200; i++) results.push(await limiter.reserve());
    expect(results.filter((r) => r.allowed)).toHaveLength(40);
    expect(results.filter((r) => !r.allowed)).toHaveLength(160);
    expect(limiter.count()).toBe(40);
  });

  it("still lets exactly 40 through when 200 calls overlap", async () => {
    const limiter = atomicLimiter(40);
    const results = await Promise.all(
      Array.from({ length: 200 }, () => limiter.reserve()),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(40);
    expect(limiter.count()).toBe(40);
  });

  it("shows why: a read-then-write check leaks badly on the same burst", async () => {
    const limiter = naiveLimiter(40);
    const results = await Promise.all(
      Array.from({ length: 200 }, () => limiter.reserve()),
    );
    // Every one of the 200 reads the pre-limit count before any of them writes.
    expect(results.filter((r) => r.allowed).length).toBeGreaterThan(40);
    expect(limiter.count()).toBeGreaterThan(40);
  });

  it("a limit of zero refuses everything rather than allowing one through", async () => {
    const limiter = atomicLimiter(0);
    expect((await limiter.reserve()).allowed).toBe(false);
    expect(limiter.count()).toBe(0);
  });
});

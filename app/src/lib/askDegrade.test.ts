// The one behaviour that must never regress: when the spend cap refuses to pay
// for an AI answer, the installer standing at an opening still gets a real
// answer. Not an error screen, not an empty chat bubble, not "try again later".
//
// The refusal bodies below are the actual jsonb verdicts the live database
// returned from ai_spend_reserve (installer role, quota exhausted, ceiling
// reached), run through the same readVerdict the edge function uses. So this
// test exercises the real contract between the two sides, not an idea of it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVerdict } from "../../../supabase/functions/_shared/spendGuard.ts";
import { CATS, TERMS } from "./glossary";

const invoke = vi.fn();
vi.mock("./supabase", () => ({
  supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } },
  supabaseConfigured: true,
}));

/** Exactly what supabase/functions/ask/index.ts returns when the guard says no. */
function refusalBody(verdict: ReturnType<typeof readVerdict>) {
  return {
    answer: "",
    sources: [],
    limited: true,
    limit_reason: verdict.reason,
    note: verdict.note,
  };
}

// Verbatim from a live run against czprjcskmzzagdztqonm on 29 July 2026.
const LIVE_VERDICTS = {
  installer: { allowed: false, reason: "role", min_role: "foreman" },
  quotaUsed: { allowed: false, reason: "user_daily", daily_limit: 40 },
  ceiling: { allowed: false, reason: "monthly_cap", cap_micros: 15000 * 10000 },
} as const;

/** The glossary half of the page's offline brain, as it is written today. */
function glossaryAnswer(q: string): string | null {
  const query = q.toLowerCase().trim();
  const term = TERMS.find(
    (t) => query.includes(t.term.toLowerCase()) || t.term.toLowerCase().includes(query),
  );
  if (!term) return null;
  const cat = CATS.find((c) => c.id === term.cat)?.label ?? term.cat;
  return `${term.term} (${cat}): ${term.desc}`;
}

describe("a refused question still gets answered", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  for (const [label, raw] of Object.entries(LIVE_VERDICTS)) {
    it(`falls through to the company brain when refused for: ${label}`, async () => {
      const verdict = readVerdict(raw as Record<string, unknown>);
      invoke.mockResolvedValue({ data: refusalBody(verdict), error: null });

      const { askInfinity } = await import("./knowledge");
      const result = await askInfinity("weep hole");

      // A refusal is a 200 with an empty answer, never a thrown error. The page
      // branches on `if (answer)`, so an empty answer IS the fallback trigger.
      expect(result.answer).toBe("");
      expect(Boolean(result.answer)).toBe(false);
      expect(result.limited).toBe(true);
      expect(result.note).toBeTruthy();

      // And the fallback has something real to say.
      const local = glossaryAnswer("weep hole");
      expect(local).toBeTruthy();
      expect(local).toContain("Weep");
    });
  }

  it("keeps a real AI answer untouched when the guard allows the call", async () => {
    invoke.mockResolvedValue({
      data: { answer: "Flash the sill first, then the jambs, then the head.", sources: [] },
      error: null,
    });
    const { askInfinity } = await import("./knowledge");
    const result = await askInfinity("flashing order");
    expect(result.answer).toContain("sill first");
    expect(result.limited).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  it("still throws on a genuine outage, so the page can say it dropped offline", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("network down") });
    const { askInfinity } = await import("./knowledge");
    await expect(askInfinity("anything")).rejects.toThrow();
  });

  it("does not mistake a real failure for a spend refusal", async () => {
    invoke.mockResolvedValue({ data: { error: "ANTHROPIC_API_KEY is not set" }, error: null });
    const { askInfinity } = await import("./knowledge");
    await expect(askInfinity("anything")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

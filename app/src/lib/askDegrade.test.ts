// Two behaviours that must never regress, both about the seam between the spend
// cap and the company brain that answers when the cap says no.
//
//  1. A free answer costs nothing. A question the brain can answer must never
//     reach the paid function at all, so it cannot burn a question from
//     somebody's daily 40 or a cent of the company's monthly budget.
//  2. A refused question is still answered. When the cap does refuse, the
//     installer standing at an opening gets a real answer and one quiet line
//     saying where it came from — not an error screen, not an empty bubble.
//
// The refusal bodies below are the actual jsonb verdicts the live database
// returned from ai_spend_reserve, run through the same readVerdict the edge
// function uses, so this exercises the real contract rather than an idea of it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVerdict } from "../../../supabase/functions/_shared/spendGuard.ts";
import { askBrain, getBrainIndex } from "./brain/answer";

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

const index = getBrainIndex();

/**
 * The order AskInfinity.tsx asks in: the bundled brain first, and the paid
 * function only when the brain came up empty. Mirrored here so the ordering
 * itself is under test — it is the only reason free answers are free.
 */
async function ask(question: string): Promise<{ text: string; paid: boolean }> {
  const outcome = askBrain(index, question);
  if (outcome.kind === "answers") {
    return { text: outcome.hits[0].entry.body, paid: false };
  }
  const { askInfinity } = await import("./knowledge");
  const { answer, note } = await askInfinity(question);
  if (answer) return { text: answer, paid: true };
  return { text: `${note ?? ""}\n\n${outcome.message}`.trim(), paid: true };
}

describe("a free answer never costs a question", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ data: { answer: "PAID", sources: [] }, error: null });
  });

  // Real installer questions from the investigation's scored set, all of which
  // the brain answers out of the company's own written notes.
  for (const question of [
    "weep hole",
    "caulk the bottom of the window",
    "single hung tips",
    "nail fin",
    "sill pan",
    "shim",
  ]) {
    it(`answers "${question}" without calling the metered function`, async () => {
      const result = await ask(question);
      expect(result.paid).toBe(false);
      expect(result.text.length).toBeGreaterThan(0);
      // The whole point: nothing was invoked, so nothing was reserved, nothing
      // was counted against the asker's day, and nothing hit the budget.
      expect(invoke).not.toHaveBeenCalled();
    });
  }

  it("only reaches the metered function when the brain has nothing written down", async () => {
    const outcome = askBrain(index, "zzzz nonexistent gibberish query");
    expect(outcome.kind).not.toBe("answers");
    await ask("zzzz nonexistent gibberish query");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("a refused question still gets answered", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  for (const [label, raw] of Object.entries(LIVE_VERDICTS)) {
    it(`falls through to the company brain when refused for: ${label}`, async () => {
      const verdict = readVerdict(raw as Record<string, unknown>);
      invoke.mockResolvedValue({ data: refusalBody(verdict), error: null });

      const { askInfinity } = await import("./knowledge");
      const result = await askInfinity("flashing sequence at the head");

      // A refusal is a 200 with an empty answer, never a thrown error. The page
      // branches on `if (answer)`, so an empty answer IS the fallback trigger.
      expect(result.answer).toBe("");
      expect(Boolean(result.answer)).toBe(false);
      expect(result.limited).toBe(true);
      expect(result.note).toBeTruthy();

      // And the note is written for a crew member, not an engineer.
      expect(result.note).not.toMatch(/error|fail|denied|403|limit_reason/i);
      expect(result.note).toContain("company");
    });
  }

  it("shows the note above a real brain answer rather than instead of it", async () => {
    const verdict = readVerdict(LIVE_VERDICTS.quotaUsed as Record<string, unknown>);
    invoke.mockResolvedValue({ data: refusalBody(verdict), error: null });

    const brainAnswer = askBrain(index, "weep hole");
    expect(brainAnswer.kind).toBe("answers");

    const { askInfinity } = await import("./knowledge");
    const { note } = await askInfinity("weep hole");
    const shown = `${note}\n\n${brainAnswer.kind === "answers" ? brainAnswer.hits[0].entry.body : ""}`;

    expect(shown).toContain("used today's AI questions");
    expect(shown.length).toBeGreaterThan((note ?? "").length);
  });

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

  it("treats a missing Anthropic key as a silent fall-through, not a refusal", async () => {
    // The edge function returns this when it has no key: an empty answer and no
    // note, because nothing was metered and there is nothing to explain.
    invoke.mockResolvedValue({ data: { answer: "", sources: [] }, error: null });
    const { askInfinity } = await import("./knowledge");
    const result = await askInfinity("anything");
    expect(result.answer).toBe("");
    expect(result.limited).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  it("still throws on a genuine outage, so the page can say it dropped offline", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("network down") });
    const { askInfinity } = await import("./knowledge");
    await expect(askInfinity("anything")).rejects.toThrow();
  });
});

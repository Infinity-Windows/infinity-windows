import { beforeEach, describe, expect, it, vi } from "vitest";

// What the Learn tab sends, and with what. This is the whole point of the
// 2026-09-05 change: the browser used to compute `score x 10` and insert it
// into the ledger itself, with no record of which terms it asked. It now
// reports WHAT WAS ASKED and lets the server do the arithmetic.
const rpcCalls: { fn: string; args: unknown }[] = [];
let rpcData: unknown = null;
let rpcError: unknown = null;

vi.mock("./supabase", () => ({
  supabase: {
    rpc: (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: rpcData, error: rpcError });
    },
    from: () => {
      throw new Error("the quiz must not write points_ledger directly");
    },
  },
}));

import {
  awardEducationQuiz,
  educationTermKey,
  EDUCATION_SEQUENCE_KEY,
  getEducationProgress,
} from "./learn";
import { TERMS } from "./glossary";

beforeEach(() => {
  rpcCalls.length = 0;
  rpcData = null;
  rpcError = null;
});

describe("educationTermKey", () => {
  it("prefixes a glossary id so a term key can never collide with the sequence", () => {
    expect(educationTermKey("frame")).toBe("term:frame");
    expect(educationTermKey(EDUCATION_SEQUENCE_KEY)).not.toBe(EDUCATION_SEQUENCE_KEY);
  });

  it("makes a key for every term in the glossary, all of them distinct", () => {
    const keys = TERMS.map((t) => educationTermKey(t.id));
    expect(new Set(keys).size).toBe(TERMS.length);
    expect(keys).not.toContain(EDUCATION_SEQUENCE_KEY);
  });
});

describe("awardEducationQuiz", () => {
  it("sends the round's keys and answers, and no total of its own", async () => {
    rpcData = { points_awarded: 20, new_terms: 2, already_had: 1 };
    const items = [
      { key: "term:frame", correct: true },
      { key: "term:jamb", correct: true },
      { key: "term:sill", correct: true },
      { key: "term:head", correct: false },
      { key: "term:mullion", correct: false },
    ];
    await awardEducationQuiz(items);
    expect(rpcCalls).toEqual([{ fn: "award_education_quiz", args: { p_items: items } }]);
    // Nothing that looks like a score or a payout leaves the browser.
    const sent = rpcCalls[0].args as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["p_items"]);
  });

  it("reads back what the round was actually worth", async () => {
    rpcData = { points_awarded: 30, new_terms: 3, already_had: 2 };
    expect(await awardEducationQuiz([])).toEqual({
      pointsAwarded: 30,
      newTerms: 3,
      alreadyHad: 2,
    });
  });

  it("reads a round that earned nothing as zero, not as a failure", async () => {
    // The everyday case now: five terms this person has already been paid for.
    rpcData = { points_awarded: 0, new_terms: 0, already_had: 5 };
    expect(await awardEducationQuiz([])).toEqual({
      pointsAwarded: 0,
      newTerms: 0,
      alreadyHad: 5,
    });
  });

  it("survives a database that predates the RPC without inventing points", async () => {
    rpcData = null;
    expect(await awardEducationQuiz([])).toEqual({
      pointsAwarded: 0,
      newTerms: 0,
      alreadyHad: 0,
    });
  });

  it("passes a refusal on so the screen can say what happened", async () => {
    rpcError = { message: "Sign in with your own crew login to earn points." };
    await expect(awardEducationQuiz([])).rejects.toEqual(rpcError);
  });
});

describe("getEducationProgress", () => {
  it("reads the earned/total line off the server, not off the glossary", async () => {
    rpcData = { terms_earned: 12, terms_total: 105, sequence_done: true };
    expect(await getEducationProgress()).toEqual({
      termsEarned: 12,
      termsTotal: 105,
      sequenceDone: true,
    });
    expect(rpcCalls[0].fn).toBe("my_education_progress");
  });

  it("shows nothing earned rather than crashing on an older database", async () => {
    rpcData = null;
    expect(await getEducationProgress()).toEqual({
      termsEarned: 0,
      termsTotal: 0,
      sequenceDone: false,
    });
  });
});

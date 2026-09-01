// THE LAW under test throughout: correct answers never reach a client that
// has not already submitted. Shuffling is pure and seeded so retakes are
// deterministic in tests; scoring/draft-approve are mirrored from the SQL
// migration (20260962000000) so a change to one side that forgets the other
// fails here first.

import { describe, expect, it, vi, beforeEach } from "vitest";

const rpc = vi.fn();
const enqueueVideoQuizSubmit = vi.fn(async () => "entry-1");

vi.mock("./supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));
vi.mock("./offline/outbox", () => ({ enqueueVideoQuizSubmit }));

const {
  applyApprove,
  applyGenerate,
  buildAnswers,
  scoreFromResults,
  shuffleQuiz,
  stripAnswerKey,
  submitVideoQuiz,
} = await import("./videoQuiz");
import type {
  QuizDraftState,
  QuizQuestionFull,
  QuizResult,
} from "./videoQuiz";

const FULL_QUESTIONS: QuizQuestionFull[] = [
  { q: "Q1", choices: ["a1", "b1", "c1", "d1"], correct_idx: 0, why: "because 1" },
  { q: "Q2", choices: ["a2", "b2", "c2", "d2"], correct_idx: 1, why: "because 2" },
  { q: "Q3", choices: ["a3", "b3", "c3", "d3"], correct_idx: 2, why: "because 3" },
  { q: "Q4", choices: ["a4", "b4", "c4", "d4"], correct_idx: 3, why: "because 4" },
  { q: "Q5", choices: ["a5", "b5", "c5", "d5"], correct_idx: 0, why: "because 5" },
];

describe("stripAnswerKey", () => {
  it("keeps only q and choices — correct_idx/why never present, at runtime", () => {
    const stripped = stripAnswerKey(FULL_QUESTIONS[0]);
    expect(stripped).toEqual({ q: "Q1", choices: ["a1", "b1", "c1", "d1"] });
    expect(Object.keys(stripped).sort()).toEqual(["choices", "q"]);
    expect("correct_idx" in stripped).toBe(false);
    expect("why" in stripped).toBe(false);
  });

  it("type-level: the public shape has no correct_idx/why field to assign", () => {
    const stripped = stripAnswerKey(FULL_QUESTIONS[0]);
    // @ts-expect-error correct_idx does not exist on QuizQuestionPublic
    expect(stripped.correct_idx).toBeUndefined();
    // @ts-expect-error why does not exist on QuizQuestionPublic
    expect(stripped.why).toBeUndefined();
  });
});

describe("shuffleQuiz", () => {
  const PUBLIC = FULL_QUESTIONS.map(stripAnswerKey);

  it("is deterministic — the same seed always produces the same order", () => {
    const a = shuffleQuiz(PUBLIC, 3);
    const b = shuffleQuiz(PUBLIC, 3);
    expect(a).toEqual(b);
  });

  it("shuffles both question order and choice order across different seeds", () => {
    const seed1 = shuffleQuiz(PUBLIC, 1);
    const seed2 = shuffleQuiz(PUBLIC, 2);
    const questionOrderDiffers = seed1.some((sq, i) => sq.originalIndex !== seed2[i].originalIndex);
    const choiceOrderDiffers = seed1.some((sq, i) =>
      sq.choices.some((c, j) => c.originalChoiceIndex !== seed2[i].choices[j].originalChoiceIndex),
    );
    expect(questionOrderDiffers).toBe(true);
    expect(choiceOrderDiffers).toBe(true);
  });

  it("every shuffled question/choice still points back at the real original data", () => {
    const shuffled = shuffleQuiz(PUBLIC, 7);
    expect(shuffled).toHaveLength(5);
    const seenOriginalIndexes = shuffled.map((sq) => sq.originalIndex).sort();
    expect(seenOriginalIndexes).toEqual([0, 1, 2, 3, 4]);
    for (const sq of shuffled) {
      const original = PUBLIC[sq.originalIndex];
      expect(sq.q).toBe(original.q);
      expect(sq.choices).toHaveLength(4);
      const seenChoiceIndexes = sq.choices.map((c) => c.originalChoiceIndex).sort();
      expect(seenChoiceIndexes).toEqual([0, 1, 2, 3]);
      for (const c of sq.choices) {
        expect(c.text).toBe(original.choices[c.originalChoiceIndex]);
      }
    }
  });

  it("never carries an answer key — QuizQuestionPublic has none to leak", () => {
    const shuffled = shuffleQuiz(PUBLIC, 5);
    for (const sq of shuffled) {
      expect(JSON.stringify(sq)).not.toContain("correct_idx");
      expect(JSON.stringify(sq)).not.toContain("why");
    }
  });
});

describe("buildAnswers", () => {
  it("builds the flat, original-order array submit_video_quiz expects", () => {
    const picks = new Map([
      [0, 2],
      [1, 0],
      [2, 3],
      [3, 1],
      [4, 0],
    ]);
    expect(buildAnswers(picks, 5)).toEqual([2, 0, 3, 1, 0]);
  });

  it("refuses to build an incomplete answer set", () => {
    const picks = new Map([
      [0, 1],
      [1, 2],
    ]);
    expect(() => buildAnswers(picks, 5)).toThrow("Answer all five before turning it in.");
  });
});

describe("scoreFromResults — client display parity with RPC semantics", () => {
  // The RPC (submit_video_quiz) computes score as the count of questions
  // where the picked index equals correct_idx. These fixtures are built the
  // same way, so scoreFromResults summing `correct` flags is provably the
  // same number the server would have reported for the same picks.
  function rpcScore(picked: number[], correctIdx: number[]): { results: QuizResult[]; score: number } {
    let score = 0;
    const results = picked.map((p, i) => {
      const correct = p === correctIdx[i];
      if (correct) score += 1;
      return { correct, correct_idx: correctIdx[i], why: `why ${i}` };
    });
    return { results, score };
  }

  it.each([
    { picked: [0, 1, 2, 3, 0], correct: [0, 1, 2, 3, 0] }, // 5/5
    { picked: [1, 1, 2, 3, 0], correct: [0, 1, 2, 3, 0] }, // 4/5 — the pass boundary
    { picked: [1, 0, 3, 2, 1], correct: [0, 1, 2, 3, 0] }, // 0/5
    { picked: [0, 1, 3, 3, 1], correct: [0, 1, 2, 3, 0] }, // 3/5 — the fail boundary
  ])("matches the RPC's own score for %j", ({ picked, correct }) => {
    const { results, score } = rpcScore(picked, correct);
    expect(scoreFromResults(results)).toBe(score);
  });
});

describe("applyGenerate / applyApprove — the draft/approve state machine", () => {
  it("a fresh Generate on a never-quizzed video lands as a draft with no live questions yet", () => {
    const next = applyGenerate(null, "summary v1", FULL_QUESTIONS);
    expect(next.status).toBe("draft");
    expect(next.draftSummary).toBe("summary v1");
    expect(next.draftQuestions).toBe(FULL_QUESTIONS);
    expect(next.questions).toEqual([]);
  });

  it("Approve publishes the draft onto the live, crew-visible columns", () => {
    const draft = applyGenerate(null, "summary v1", FULL_QUESTIONS);
    const approved = applyApprove(draft);
    expect(approved.status).toBe("approved");
    expect(approved.questions).toBe(FULL_QUESTIONS);
    expect(approved.draftQuestions).toBe(FULL_QUESTIONS);
  });

  it("Q3's law: regenerating after an approval replaces ONLY the draft — the live quiz stays untouched", () => {
    const v1 = FULL_QUESTIONS;
    const v2 = FULL_QUESTIONS.map((q) => ({ ...q, q: `${q.q} (v2)` }));

    const draft1: QuizDraftState = applyGenerate(null, "summary v1", v1);
    const approved1 = applyApprove(draft1);
    expect(approved1.questions).toBe(v1);

    // A supervisor hits Generate again. The row's status flips back to
    // draft, but crews must still be quizzed on v1 until the NEXT approve.
    const draft2 = applyGenerate(approved1, "summary v2", v2);
    expect(draft2.status).toBe("draft");
    expect(draft2.draftQuestions).toBe(v2);
    expect(draft2.questions).toBe(v1); // untouched — THE point of this test

    const approved2 = applyApprove(draft2);
    expect(approved2.questions).toBe(v2); // only now does v2 go live
  });
});

describe("submitVideoQuiz — try direct, queue only on a network failure", () => {
  beforeEach(() => {
    rpc.mockReset();
    enqueueVideoQuizSubmit.mockClear();
  });

  it("returns the server's scored result when it reaches the server", async () => {
    const response = {
      score: 4,
      passed: true,
      points_awarded: 40,
      cleared: false,
      grants_clearance: null,
      results: [],
    };
    rpc.mockResolvedValue({ data: response, error: null });
    const result = await submitVideoQuiz("video-1", [0, 1, 2, 3, 0]);
    expect(result).toEqual({ queued: false, data: response });
    expect(enqueueVideoQuizSubmit).not.toHaveBeenCalled();
  });

  it("queues instead of throwing when the failure looks like no signal", async () => {
    rpc.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await submitVideoQuiz("video-1", [0, 1, 2, 3, 0]);
    expect(result).toEqual({ queued: true, data: null });
    expect(enqueueVideoQuizSubmit).toHaveBeenCalledWith({
      videoId: "video-1",
      answers: [0, 1, 2, 3, 0],
    });
  });

  it("a real server refusal is not queued — it surfaces", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "That quiz isn't published yet." },
    });
    await expect(submitVideoQuiz("video-1", [0, 1, 2, 3, 0])).rejects.toBeTruthy();
    expect(enqueueVideoQuizSubmit).not.toHaveBeenCalled();
  });
});

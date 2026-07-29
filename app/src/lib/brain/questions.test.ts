import { describe, expect, it } from "vitest";
import { askBrain, getBrainIndex } from "./answer";
import {
  BRAIN_QUESTIONS,
  PREDICTED_SCORE,
  PREDICTED_USEFUL,
  SCORE_BEFORE,
  type BrainQuestion,
} from "./questions";

/**
 * The scoreboard from docs/ask-infinity-token-free.md, run for real against the
 * bundled brain — no network, no model, no API key.
 *
 * "Correct" means the top answer shown answers the question. "Useful" means one
 * of the three answers shown is at least the right topic. The floor asserted
 * below is the investigation's own prediction: if a change drops the brain under
 * it, this fails and names the questions that regressed.
 *
 * To add a question, put it in questions.ts with the entry ids that genuinely
 * answer it. Never widen `correct` to make a failing question pass.
 */

const index = getBrainIndex();

type Verdict = "correct" | "useful" | "wrong" | "quiet" | "live";

interface Outcome {
  q: BrainQuestion;
  ids: string[];
  verdict: Verdict;
}

function ask(q: BrainQuestion): Outcome {
  const out = askBrain(index, q.question);
  const ids = out.kind === "answers" ? out.hits.map((h) => h.entry.id) : [];
  const correct = new Set(q.correct ?? []);
  const useful = new Set([...(q.correct ?? []), ...(q.useful ?? [])]);
  let verdict: Verdict;
  if (out.kind === "live") verdict = "live";
  else if (ids.length === 0) verdict = "quiet";
  else if (correct.has(ids[0])) verdict = "correct";
  else if (ids.some((id) => useful.has(id))) verdict = "useful";
  else verdict = "wrong";
  return { q, ids, verdict };
}

const outcomes = BRAIN_QUESTIONS.map(ask);
const byNumber = new Map(outcomes.map((o) => [o.q.n, o]));

const correctCount = outcomes.filter((o) => o.verdict === "correct").length;
const usefulCount = outcomes.filter((o) => o.verdict === "correct" || o.verdict === "useful").length;

describe("Ask Infinity scores the 28 real installer questions", () => {
  it(`answers at least ${PREDICTED_SCORE} of 28 correctly (was ${SCORE_BEFORE})`, () => {
    const missed = outcomes
      .filter((o) => o.verdict !== "correct")
      .map((o) => `Q${o.q.n} (${o.verdict}) "${o.q.question}" → ${o.ids[0] ?? "nothing"}`);
    expect(correctCount, `not correct:\n${missed.join("\n")}`).toBeGreaterThanOrEqual(
      PREDICTED_SCORE,
    );
  });

  it(`puts something useful in the three shown for at least ${PREDICTED_USEFUL} of 28`, () => {
    const unhelpful = outcomes
      .filter((o) => o.verdict === "wrong" || o.verdict === "quiet")
      .map((o) => `Q${o.q.n} "${o.q.question}" → ${o.ids.join(", ") || "nothing"}`);
    expect(usefulCount, `nothing useful:\n${unhelpful.join("\n")}`).toBeGreaterThanOrEqual(
      PREDICTED_USEFUL,
    );
  });

  it("beats the 6 of 28 the previous version managed", () => {
    expect(SCORE_BEFORE).toBe(6);
    expect(correctCount).toBeGreaterThan(SCORE_BEFORE);
  });

  it("shows up to three answers, never just one", () => {
    const answered = outcomes.filter((o) => o.ids.length > 0);
    expect(answered.length).toBeGreaterThan(20);
    for (const o of answered) expect(o.ids.length).toBeLessThanOrEqual(3);
    // Most questions genuinely have more than one relevant entry to offer.
    expect(answered.filter((o) => o.ids.length > 1).length).toBeGreaterThan(15);
  });
});

describe("each question, individually", () => {
  it.each(
    BRAIN_QUESTIONS.filter((q) => !q.expectMiss).map((q) => [q.n, q.question] as const),
  )("Q%i is answered or at least on-topic: %s", (n) => {
    const o = byNumber.get(n)!;
    expect(
      o.verdict,
      `top answer was ${o.ids[0] ?? "nothing"}; expected one of ${o.q.correct?.join(", ")}`,
    ).not.toBe("wrong");
    expect(o.verdict).not.toBe("quiet");
  });

  it.each(
    BRAIN_QUESTIONS.filter((q) => q.expectMiss).map((q) => [q.n, q.question] as const),
  )("Q%i has no written answer, so the brain must not claim one: %s", (n) => {
    const o = byNumber.get(n)!;
    expect(o.verdict, `gap: ${o.q.gap}`).not.toBe("correct");
  });
});

describe("the app tour", () => {
  it("never answers a question about the craft", () => {
    for (const q of BRAIN_QUESTIONS) {
      const o = byNumber.get(q.n)!;
      expect(o.ids, `Q${q.n} "${q.question}"`).not.toContain("app:tour");
    }
  });

  it("still answers a question about using the app", () => {
    const appQuestions = [
      "How do I clock in?",
      "Which tab has the pick list?",
      "Where do I scan a unit?",
      "How do I use the app?",
    ];
    for (const question of appQuestions) {
      const out = askBrain(index, question);
      const ids = out.kind === "answers" ? out.hits.map((h) => h.entry.id) : [];
      expect(ids, question).toContain("app:tour");
    }
  });
});

/**
 * The score as it stands, question by question, committed so that any change to
 * the index shows up as a diff here rather than as a silent drift. Moving a line
 * up (wrong → correct) is the point of the exercise; moving one down needs a
 * reason in the pull request.
 */
const RECORDED: Record<number, Verdict> = {
  1: "correct", 2: "correct", 3: "correct", 4: "correct", 5: "correct", 6: "correct",
  7: "correct", 8: "useful", 9: "correct", 10: "correct", 11: "correct", 12: "correct",
  13: "correct", 14: "correct", 15: "correct", 16: "correct", 17: "correct", 18: "correct",
  19: "correct", 20: "correct", 21: "correct", 22: "wrong", 23: "correct", 24: "useful",
  25: "live", 26: "quiet", 27: "useful", 28: "correct",
};

describe("the recorded scoreboard", () => {
  it("still reads 22 correct and 25 useful out of 28", () => {
    const actual = Object.fromEntries(outcomes.map((o) => [o.q.n, o.verdict]));
    expect(actual).toEqual(RECORDED);
    expect({ correct: correctCount, useful: usefulCount }).toEqual({ correct: 22, useful: 25 });
  });
});

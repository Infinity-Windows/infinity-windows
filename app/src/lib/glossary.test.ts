import { describe, expect, it } from "vitest";
import {
  buildDeck,
  CATS,
  dueDateFor,
  knowledgeScore,
  nextBox,
  nextStepQuestion,
  PROC,
  procDisplayStep,
  procSequence,
  quizQuestion,
  quizRound,
  sequenceRound,
  TERMS,
  type CardProgress,
} from "./glossary";

describe("glossary content", () => {
  it("has the full ported catalog", () => {
    expect(CATS.length).toBe(8);
    expect(TERMS.length).toBe(105);
    expect(PROC.length).toBe(18);
  });
  it("has no dangling term links", () => {
    const ids = new Set(TERMS.map((t) => t.id));
    for (const t of TERMS) for (const l of t.links ?? []) expect(ids.has(l)).toBe(true);
  });
});

describe("install-sequence game", () => {
  it("orders window steps by step number", () => {
    const seq = procSequence("win");
    for (let i = 1; i < seq.length; i++) expect(seq[i].step).toBeGreaterThanOrEqual(seq[i - 1].step);
    expect(seq.every((s) => s.branch === "main" || s.branch === "win")).toBe(true);
  });
  it("the correct answer is the step that actually follows", () => {
    let seed = 0.42;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const q = nextStepQuestion("door", rnd);
    const seq = procSequence("door");
    const idx = seq.findIndex((s) => s.id === q.current.id);
    expect(seq[idx + 1].id).toBe(q.answer.id);
    expect(q.options).toContainEqual(q.answer);
  });
  it("samples five different next-step questions and avoids last round when possible", () => {
    const first = sequenceRound("door");
    const second = sequenceRound("door", first.map((q) => q.current.id));
    expect(new Set(first.map((q) => q.current.id)).size).toBe(5);
    expect(new Set(second.map((q) => q.current.id)).size).toBe(5);
    expect(second.some((q) => first.some((previous) => previous.current.id === q.current.id))).toBe(false);
  });
  it("shows consecutive door numbers without changing the source procedure", () => {
    const door = procSequence("door");
    expect(door.map((step) => procDisplayStep("door", step.id))).toEqual(door.map((_, i) => i + 1));
    expect(procDisplayStep("door", "d3")).toBe(8);
    expect(procDisplayStep("door", "pr6")).toBe(9);
    expect(PROC.find((step) => step.id === "pr6")?.step).toBe(10);
  });
});

describe("Leitner SRS", () => {
  it("resets to box 0 on 'again' and advances on 'got'", () => {
    expect(nextBox(3, "again")).toBe(0);
    expect(nextBox(1, "got")).toBe(2);
  });
  it("caps at the top box", () => {
    expect(nextBox(5, "got")).toBe(5);
  });
  it("due date pushes further out with higher boxes", () => {
    const b1 = dueDateFor(1, new Date("2026-01-01"));
    const b5 = dueDateFor(5, new Date("2026-01-01"));
    expect(b5 > b1).toBe(true);
  });
});

describe("buildDeck", () => {
  it("puts priority terms first", () => {
    const prog: CardProgress[] = TERMS.map((t) => ({ term_id: t.id, box: 3, due: "2999-01-01" }));
    const deck = buildDeck(prog, [TERMS[5].id], 5, "2026-01-01");
    expect(deck[0].id).toBe(TERMS[5].id);
  });
  it("includes new (unseen) terms as due", () => {
    const deck = buildDeck([], [], 5, "2026-01-01");
    expect(deck.length).toBe(5);
  });
  it("excludes not-yet-due seen cards", () => {
    const prog: CardProgress[] = TERMS.map((t) => ({ term_id: t.id, box: 3, due: "2999-01-01" }));
    const deck = buildDeck(prog, [], 5, "2026-01-01");
    expect(deck.length).toBe(0);
  });
});

describe("knowledgeScore", () => {
  it("is 0 with no progress and 100 when all mastered", () => {
    expect(knowledgeScore([])).toBe(0);
    const mastered: CardProgress[] = TERMS.map((t) => ({ term_id: t.id, box: 5, due: "2999" }));
    expect(knowledgeScore(mastered)).toBe(100);
  });
});

describe("quizQuestion", () => {
  it("returns 4 options including the answer", () => {
    const q = quizQuestion(TERMS[0]);
    expect(q.options).toHaveLength(4);
    expect(q.options.some((o) => o.id === q.answer.id)).toBe(true);
  });
  it("draws unique terms across a round and prefers new terms the next round", () => {
    const first = quizRound();
    const second = quizRound(first.map((q) => q.answer.id));
    expect(new Set(first.map((q) => q.answer.id)).size).toBe(5);
    expect(new Set(second.map((q) => q.answer.id)).size).toBe(5);
    expect(second.some((q) => first.some((previous) => previous.answer.id === q.answer.id))).toBe(false);
  });
});

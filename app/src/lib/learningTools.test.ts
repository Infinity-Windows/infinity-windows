// The lesson write-up shape and the Ask tool that prepares one, driven through
// the real field executor with a mocked caller-scoped client.
import { describe, expect, it } from "vitest";
import {
  LEARNING_HEADINGS, LEARNING_TOOLS, emptyLearningContent, formatBreakdown, learningInput, mergeLearning, missingHeadings, normalizeLearning, sendBlocker,
} from "../../../supabase/functions/_shared/learningTools";
import { fieldExecutor, newFieldState } from "../../../supabase/functions/ask/field";

const JOB = "00000000-0000-4000-8000-000000000100";
const UNIT = "00000000-0000-4000-8000-000000000200";
const REQ = "00000000-0000-4000-8000-000000000900", LATER = "00000000-0000-4000-8000-000000000901";
const nothing = { project_id: JOB, unit_id: null, unit_label: null, issue: null, what_happened: null, impact: null, impact_minutes: null,
  impact_cost_dollars: null, lesson_learned: null, preventive_action: null, unknown: [], reviewer_name: null };

describe("the five headings", () => {
  it("keeps the original breakdown order and labels, Unknown explicit, impact self-reported", () => {
    const c = normalizeLearning({ issue: " Leak ", what_happened: "Corner leaked", impact_minutes: 45, impact_cost_cents: 1250, unknown: ["lesson_learned"] });
    expect(missingHeadings(c)).toEqual(["preventive_action"]);
    expect(formatBreakdown(c).split("\n")).toEqual([
      "Issue: Leak", "What happened: Corner leaked", "Impact: (self-reported: 45 min, $12.50)", "Lesson learned: Unknown", "Preventive action: Not answered yet"]);
    expect(LEARNING_HEADINGS).toEqual(["issue", "what_happened", "impact", "lesson_learned", "preventive_action"]);
  });
  it("mirrors the database rules", () => {
    expect(() => normalizeLearning({ issue: "x", unknown: ["issue"] })).toThrow(/both answered and Unknown/);
    expect(() => normalizeLearning({ impact_minutes: 1.5 })).toThrow(/whole numbers/);
    expect(sendBlocker(normalizeLearning({ issue: "x", unknown: ["what_happened", "impact", "lesson_learned", "preventive_action"] }))).toBe("issue_and_what_happened");
  });
  it("merges: said now replaces, silence keeps, unknown clears only what was not said again", () => {
    const first = mergeLearning(null, { issue: "Leak", impact: "Redo" });
    const second = mergeLearning(first, { what_happened: "Corner", unknown: ["impact"] });
    expect(second).toMatchObject({ issue: "Leak", what_happened: "Corner", impact: null, unknown: ["impact"] });
    expect(mergeLearning(second, { impact: "Two hours" }).unknown).toEqual([]);
  });
});

describe("the Ask tool", () => {
  it("is strict and has no save, send, reviewer-choice or approval field", () => {
    const schema = LEARNING_TOOLS[0].input_schema as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
    expect(Object.keys(schema.properties).filter((k) => /submit|send|approve|confirm|reviewer_id|forward|deliver/.test(k))).toEqual([]);
  });
  it("converts spoken dollars to cents and refuses a job it was not given", () => {
    expect(learningInput({ ...nothing, impact_cost_dollars: 12.5 }).content.impact_cost_cents).toBe(1250);
    expect(() => learningInput({ ...nothing, project_id: "Smith job" })).toThrow(/get_field_context/);
  });
  it("prepares on screen only: reads the job and reviewer, saves the draft with the request, never submits", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = { rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "ai_field_context") return { data: { job: { name: "Deck", job_code: "DECK" }, units: [{ unit_id: UNIT, label: "16" }] }, error: null };
      if (name === "hex_learning_reviewers") return { data: { status: "choose", match: null, choices: [{ id: "a", name: "Maria Diaz", role: "supervisor", exact: true }, { id: "b", name: "maria diaz", role: "foreman", exact: true }] }, error: null };
      return { data: null, error: null };
    } };
    const state = newFieldState(REQ, [], null);
    const run = fieldExecutor(client as never, 0, state);
    const out = await run("prepare_learning_draft", { ...nothing, unit_label: "16", issue: "Sill pan leaked", reviewer_name: "Maria Diaz" });
    expect(out.is_error).toBeUndefined();
    expect(JSON.parse(out.content).guidance).toMatch(/NOT saved and NOT sent/);
    expect(state.learning).toMatchObject({ request_id: REQ, project_id: JOB, unit_id: UNIT, unit_label: "16", reviewer: { status: "choose", said: "Maria Diaz" } });
    expect(state.learning!.missing).toEqual(["what_happened", "impact", "lesson_learned", "preventive_action"]);
    expect(calls.map((c) => c.name)).toEqual(["ai_field_context", "hex_learning_reviewers", "ai_field_save_draft"]);
    expect(calls.some((c) => /hex_learning_(save|submit|decide|withdraw)|hex_portal_save_case/.test(c.name))).toBe(false);
    expect((calls[2].args.p_captured as { learning: unknown }).learning).toEqual(state.learning);
    // A later message in the same conversation keeps the first message as the source.
    const later = newFieldState(LATER, [], { learning: state.learning });
    await fieldExecutor(client as never, 0, later)("prepare_learning_draft", { ...nothing, what_happened: "Water test failed" });
    expect(later.learning).toMatchObject({ request_id: REQ, unit_id: UNIT, content: { issue: "Sill pan leaked", what_happened: "Water test failed" } });
  });
  it("a unit id from outside the job is refused", async () => {
    const client = { rpc: async (name: string) => ({ data: name === "ai_field_context" ? { job: { name: "Deck" }, units: [] } : null, error: null }) };
    const out = await fieldExecutor(client as never, 0, newFieldState(REQ, [], null))("prepare_learning_draft", { ...nothing, unit_id: UNIT });
    expect(out.is_error).toBe(true);
  });
  it("a tampered saved draft is dropped rather than trusted", () => {
    expect(newFieldState(REQ, [], { learning: { request_id: "x", project_id: JOB, content: emptyLearningContent() } }).learning).toBeNull();
  });
});

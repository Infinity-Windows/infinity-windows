// Synthetic tool sequences through the real field executor, with a mocked
// caller-scoped client. No network, no model, no database.
import { describe, expect, it } from "vitest";
import { fieldErrorMessage, fieldExecutor, newFieldState } from "../../../supabase/functions/ask/field";
import { completeAnswers } from "../../../supabase/functions/_shared/fieldTools";

const JOB = "00000000-0000-4000-8000-000000000100";
const OTHER = "00000000-0000-4000-8000-000000000101";
const REQ = "00000000-0000-4000-8000-000000000900";
type Call = { name: string; args: Record<string, unknown> };

function client(replies: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: unknown }>) {
  const calls: Call[] = [];
  return {
    calls,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const r = replies[name]?.(args) ?? { data: null };
      return { data: r.data ?? null, error: r.error ?? null };
    },
  };
}
const unit = (over: Record<string, unknown>) => completeAnswers(over);

describe("field executor", () => {
  it("keeps a long interview's answers and saves them durably after every message", async () => {
    const c = client({});
    const state = newFieldState(REQ, [], { answers: { job: { name: "Pine Hollow", location: "12 Ridge Rd" }, unit: unit({ label: "4", material: "Aluminum" }) } });
    const run = fieldExecutor(c as never, 0, state);
    await run("record_setup_answers", { job: null, unit: unit({ label: "4", story: "2", unknown: ["electrical"] }) });
    expect(state.draft.unit).toMatchObject({ label: "4", material: "Aluminum", story: "2", unknown: ["electrical"] });
    const save = c.calls.find((x) => x.name === "ai_field_save_draft")!;
    expect(save.args.p_id).toBe(REQ);
    expect((save.args.p_captured as { answers: { job: { name: string } } }).answers.job.name).toBe("Pine Hollow");
  });

  it("fills a save from the same unit's draft on the same job, never across jobs", async () => {
    const c = client({ ai_field_command: () => ({ data: { status: "done", outcome: "details_added", action_id: "a1", project_id: JOB } }) });
    const state = newFieldState(REQ, [], { answers: { job: { name: "Pine Hollow", location: null, project_id: JOB }, unit: unit({ label: "4", material: "Aluminum" }) } });
    const run = fieldExecutor(c as never, 0, state);
    await run("save_field_unit", { project_id: JOB, unit_id: null, opening_id: null, unit: unit({ label: "4", story: "1" }) });
    const sameJob = c.calls.find((x) => x.name === "ai_field_command")!.args.p_data as { facts: Record<string, unknown> };
    expect(sameJob.facts).toMatchObject({ material: "Aluminum", story: "1" });
    await run("save_field_unit", { project_id: OTHER, unit_id: null, opening_id: null, unit: unit({ label: "4", story: "1" }) });
    const otherJob = c.calls.filter((x) => x.name === "ai_field_command")[1].args.p_data as { facts: Record<string, unknown> };
    expect(otherJob.facts.material).toBeUndefined();
  });

  it("shows receipts exactly as the database returned them, including waiting choices", async () => {
    const waiting = { status: "needs_choice", reason: "on_break", action_id: "a2", preview_hash: "seal", options: [{ id: "end_break_and_start", label: "x" }] };
    const c = client({ ai_field_command: () => ({ data: waiting }) });
    const state = newFieldState(REQ, [], null);
    const out = await fieldExecutor(c as never, 0, state)("start_unit_work", { project_id: JOB, unit_id: JOB, stage: "Installing", participation: "install" });
    expect(state.receipts).toEqual([waiting]);
    expect(out.content).toContain("NOT done yet");
    expect(out.content).not.toContain("seal");
  });

  it("a failed step never claims the whole message was undone", async () => {
    let n = 0;
    const c = client({
      ai_field_command: () => (++n === 1
        ? { data: { status: "done", outcome: "created", action_id: "a1", project_id: JOB, name: "Pine Hollow" } }
        : { error: { code: "P0001", message: "Choose a unit on this job first." } }),
    });
    const state = newFieldState(REQ, [], null);
    const run = fieldExecutor(c as never, 0, state);
    await run("create_field_job", { name: "Pine Hollow", location: "12 Ridge Rd" });
    const failed = await run("start_unit_work", { project_id: JOB, unit_id: JOB, stage: "Installing", participation: "install" });
    expect(failed.is_error).toBe(true);
    expect(failed.content).toMatch(/Choose a unit on this job first\. This step was not saved\. Anything already shown as saved stays saved\./);
    expect(state.receipts).toHaveLength(1);
  });

  it("never passes raw database errors to the model", () => {
    expect(fieldErrorMessage({ code: "23505", message: 'duplicate key value violates unique constraint "ai_field_actions_pkey"' })).not.toContain("constraint");
    expect(fieldErrorMessage(new Error("Ask for the work date."))).toContain("Ask for the work date.");
  });

  it("refuses crew records below foreman before touching the database", async () => {
    const c = client({});
    const out = await fieldExecutor(c as never, 0, newFieldState(REQ, [], null))("record_crew_work", { project_id: JOB, unit_id: JOB, unit_label: null, unit_type: null, people: [JOB], work_date: "2026-09-21", stage: "Hardware", outcome: "partial", description: null });
    expect(out.is_error).toBe(true);
    expect(c.calls).toHaveLength(0);
  });

  it("uses only the caller's client and only the named RPCs", async () => {
    const c = client({ ai_field_context: () => ({ data: { jobs: [] } }) });
    await fieldExecutor(c as never, 1, newFieldState(REQ, [], null))("get_field_context", { project_id: null, search: "pine" });
    expect(c.calls).toEqual([{ name: "ai_field_context", args: { p_job: null, p_search: "pine" } }]);
    const bad = await fieldExecutor(c as never, 1, newFieldState(REQ, [], null))("get_field_context", { project_id: "Pine Hollow", search: null });
    expect(bad.is_error).toBe(true);
  });
});

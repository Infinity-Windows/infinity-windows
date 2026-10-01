import { describe, expect, it, vi } from "vitest";
import { navigationExecutor, newNavigationState } from "../../../supabase/functions/ask/navigation";
import { navigationHref, navigationLabel, readNavigationAction } from "../../../supabase/functions/_shared/askNavigation";

const JOB = "11111111-1111-4111-8111-111111111111";
const OPENING = "22222222-2222-4222-8222-222222222222";
const UNIT = "33333333-3333-4333-8333-333333333333";
const PERSON = "44444444-4444-4444-8444-444444444444";
const context = { project_id: JOB, project_label: "Black Desert", unit_id: null, opening_id: OPENING, unit_label: "W-12" };

describe("Take me there destinations", () => {
  it("offers a schedule button without a lookup or a model-written URL", async () => {
    const rpc = vi.fn();
    const state = newNavigationState();
    const result = await navigationExecutor({ rpc }, PERSON, null, state)("offer_navigation", { destination: "schedule", job: null, unit: null, url: "https://other.example" });
    expect(JSON.parse(result.content).offered).toBe(true);
    expect(state.action).toEqual({ kind: "schedule" });
    expect(rpc).not.toHaveBeenCalled();
    expect(navigationHref(state.action!)).toBe("/my-schedule");
    expect(navigationLabel(state.action!, true)).toBe("Abrir mi horario");
    expect(readNavigationAction({ kind: "schedule", url: "https://other.example" })).toEqual({ kind: "schedule" });
  });

  it("uses the scoped job context and exact opening record before offering a link", async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "can_access_project_chat") return { data: args.p_uid === PERSON && args.p_project_id === JOB, error: null };
      if (name === "ai_field_context") return { data: { units: [{ unit_id: null, opening_id: OPENING, label: "W-12", map_code: "W-12" }] }, error: null };
      throw new Error(name);
    });
    const state = newNavigationState();
    const result = await navigationExecutor({ rpc }, PERSON, context, state)("offer_navigation", { destination: "unit", job: null, unit: null });
    expect(JSON.parse(result.content).offered).toBe(true);
    expect(rpc).toHaveBeenCalledWith("can_access_project_chat", { p_project_id: JOB, p_uid: PERSON });
    expect(state.action).toEqual({ kind: "unit", project_id: JOB, opening_id: OPENING, unit_id: null, label: "W-12" });
    expect(navigationHref(state.action!)).toBe(`/projects/${JOB}/opening/${OPENING}`);
  });

  it("routes a saved custom-work unit to Current Work", async () => {
    const rpc = vi.fn(async (name: string) => name === "can_access_project_chat"
      ? { data: true, error: null }
      : { data: { units: [{ unit_id: UNIT, opening_id: OPENING, label: "Door 4", map_code: "D-4" }] }, error: null });
    const state = newNavigationState();
    await navigationExecutor({ rpc }, PERSON, context, state)("offer_navigation", { destination: "unit", job: null, unit: "Door 4" });
    expect(navigationHref(state.action!)).toBe(`/current-work?job=${JOB}&unit=${UNIT}`);
    expect(readNavigationAction(state.action)).toEqual({ kind: "unit", project_id: JOB, unit_id: UNIT, opening_id: null, label: "Door 4" });
  });

  it("resolves an exact job code and unit code when Ask has no screen context", async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "can_access_project_chat") return { data: true, error: null };
      if (args.p_job === null) return { data: { jobs: [{ id: JOB, name: "Black Desert", job_code: "BD" }] }, error: null };
      return { data: { units: [{ unit_id: UNIT, opening_id: null, label: "Door 4", map_code: "D-4" }] }, error: null };
    });
    const state = newNavigationState();
    const result = await navigationExecutor({ rpc }, PERSON, null, state)("offer_navigation", { destination: "unit", job: "BD", unit: "D-4" });
    expect(JSON.parse(result.content).offered).toBe(true);
    expect(rpc).toHaveBeenCalledWith("ai_field_context", { p_job: null, p_search: "BD" });
    expect(rpc).toHaveBeenCalledWith("ai_field_context", { p_job: JOB, p_search: "D-4" });
    expect(navigationHref(state.action!)).toBe(`/current-work?job=${JOB}&unit=${UNIT}`);
  });

  it("refuses a unit on a job outside the caller's access", async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }));
    const state = newNavigationState();
    const result = await navigationExecutor({ rpc }, PERSON, context, state)("offer_navigation", { destination: "unit", job: null, unit: "W-12" });
    expect(JSON.parse(result.content).offered).toBe(false);
    expect(state.action).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("requires one exact job and one exact unit, and drops malformed client actions", async () => {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "can_access_project_chat") return { data: true, error: null };
      if (args.p_job === null) return { data: { jobs: [{ id: JOB, name: "Black Desert", job_code: "BD" }] }, error: null };
      return { data: { units: [
        { unit_id: UNIT, opening_id: null, label: "4", map_code: null },
        { unit_id: OPENING, opening_id: null, label: "4", map_code: null },
      ] }, error: null };
    });
    const state = newNavigationState();
    const tool = navigationExecutor({ rpc }, PERSON, null, state);
    expect(JSON.parse((await tool("offer_navigation", { destination: "unit", job: "Black", unit: "4" })).content).offered).toBe(false);
    expect(JSON.parse((await tool("offer_navigation", { destination: "unit", job: "Black Desert", unit: "4" })).content).offered).toBe(false);
    expect(state.action).toBeNull();
    expect(readNavigationAction({ kind: "unit", project_id: JOB, opening_id: "javascript:alert(1)", label: "4" })).toBeNull();
  });
});

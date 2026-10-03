import { describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./supabase", () => ({ supabase: { rpc } }));
import { getCrewGoal } from "./crewGoal";

describe("crew goal read", () => {
  it("uses one project-scoped RPC and leaves its aggregate unchanged across repeat fetches", async () => {
    const safe = { goal_hours: 120, goal_revision: 2, recorded_hours: 72, running_provisional_hours: 2,
      allowance_hours: 46, open_shifts: 1, unresolved_shifts: 0, goal_updated_at: "2026-10-03T12:00:00Z", as_of: "2026-10-03T13:00:00Z" };
    rpc.mockResolvedValue({ data: safe, error: null });
    expect(await getCrewGoal("job-a")).toEqual(safe);
    expect(await getCrewGoal("job-a")).toEqual(safe);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("crew_goal_summary", { p_project_id: "job-a" });
  });
  it("degrades when the database function has not been installed", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find function" } });
    expect(await getCrewGoal("job-a")).toBeNull();
  });
  it("does not hide a server access denial", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "This job is unavailable." } });
    await expect(getCrewGoal("hidden-job")).rejects.toMatchObject({ code: "42501" });
  });
});

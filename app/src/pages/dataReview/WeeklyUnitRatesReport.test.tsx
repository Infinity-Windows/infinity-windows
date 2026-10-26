// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
vi.mock("../../lib/signedIn", () => ({ signInMark: () => ({ userId: "owner", generation: 1 }) }));
vi.mock("../../lib/timeclock", async original => ({ ...await original<typeof import("../../lib/timeclock")>(), listFirstFinishedShifts: vi.fn(async () => [{ id: "s", project_id: "A", clock_in_at: "2026-09-02T12:00:00Z", clock_out_at: "2026-09-02T13:00:00Z", status: "finished" }]) }));
vi.mock("../../lib/customWork/api", () => ({ listWorkSessions: vi.fn(async () => []), listWorkUnits: vi.fn(async () => []) }));
vi.mock("./historicalLabor", async original => ({ ...await original<typeof import("./historicalLabor")>(), readHistoricalLabor: vi.fn(async () => []) }));
import { listFirstFinishedShifts } from "../../lib/timeclock";
import { listWorkSessions } from "../../lib/customWork/api";
import { WeeklyUnitRatesReport } from "./WeeklyUnitRatesReport";
import { midnight } from "./generalLabor";
it("loads only bounded relative windows when requested and stops inactive reads", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div"), root = createRoot(host);
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><WeeklyUnitRatesReport rows={[]} units={[]} jobs={["A"]} people={[]} source="combined" from={midnight("2026-10-01")} until={midnight("2026-10-08")} filter={() => true} onInspect={() => {}} /></QueryClientProvider>));
    expect(listFirstFinishedShifts).not.toHaveBeenCalled();
    expect(listWorkSessions).not.toHaveBeenCalled();
    await act(async () => { const axis = host.querySelector<HTMLSelectElement>('[aria-label="Unit rates time axis"]')!; axis.value = "relative"; axis.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle(); await settle();
    expect(vi.mocked(listFirstFinishedShifts).mock.calls[0][0]).toEqual(["A"]);
    expect(vi.mocked(listWorkSessions).mock.calls[0][2]).toMatchObject({ projectIds: ["A"], from: midnight("2026-09-02"), until: midnight("2026-10-28") });
    const queries = client.getQueryCache().getAll().filter(query => query.queryKey[2] === "workSessions");
    expect((queries[0].options as { refetchInterval?: unknown }).refetchInterval).toBe(false);
    const calls = vi.mocked(listWorkSessions).mock.calls.length;
    await act(async () => root.unmount());
    await client.invalidateQueries(); await settle();
    expect(listWorkSessions).toHaveBeenCalledTimes(calls);
  } finally { client.clear(); }
});

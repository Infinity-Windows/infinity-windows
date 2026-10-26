// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { useReportShifts, mergeRecentShifts } from "./useReportShifts";
import { reportShifts } from "./reportQueries";
import { listTeamShifts, type TimeShift } from "../../lib/timeclock";
vi.mock("../../lib/api", () => ({ listProjectsAnyStatus: vi.fn() }));
vi.mock("../../lib/signedIn", () => ({ signInMark: () => ({ userId: "owner", generation: 1 }) }));
vi.mock("../../lib/timeclock", () => ({ listTeamShifts: vi.fn() }));
const row = (id: string, at: number, open = false) => ({ id, clock_in_at: new Date(at).toISOString(), clock_out_at: open ? null : new Date(at + 3600000).toISOString(), status: "approved" } as TimeShift);
it("replaces only verified recent/open coverage and preserves older closed history", () => {
  const old = row("old", 0), running = row("running", 1, true), removed = row("voided", 100);
  const changed = row("new", 101);
  expect(mergeRecentShifts([old, running, removed], [changed], 100, 200, ["running"]).map(r => r.id)).toEqual(["new", "old"]);
});
it("shares a scoped snapshot, polls recent and older unfinished punches, and pauses inactive views", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const now = Date.now(), from = now - 10 * 86400000, until = now + 86400000;
  const old = row("old", from), running = row("running", from, true), latest = row("latest", now);
  vi.mocked(listTeamShifts).mockImplementation(async (_from, _until, _person, options) => options?.ids ? [] : _from === new Date(from).toISOString() ? [old, running] : [latest]);
  const client = new QueryClient();
  const host = document.createElement("div"), root = createRoot(host);
  function View({ active }: { active: boolean }) { useReportShifts("owner", ["job"], from, until, active); return null; }
  const render = async (active: boolean) => { await act(async () => { root.render(<QueryClientProvider client={client}><View active={active} /><View active={active} /></QueryClientProvider>); await vi.advanceTimersByTimeAsync(20); }); };
  try {
    await render(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    const key = reportShifts("owner", ["job"], from, until, true).queryKey;
    expect(client.getQueryData<TimeShift[]>(key)?.map(r => r.id)).toEqual(["latest", "old"]);
    expect(listTeamShifts).toHaveBeenCalledTimes(3);
    expect(vi.mocked(listTeamShifts).mock.calls[2][3]?.ids).toEqual(["running"]);
    await render(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(listTeamShifts).toHaveBeenCalledTimes(3);
  } finally { await act(async () => root.unmount()); client.clear(); vi.useRealTimers(); }
});

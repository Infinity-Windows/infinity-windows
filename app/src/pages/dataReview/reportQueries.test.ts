import { QueryClient, QueryObserver, focusManager, onlineManager } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { mapReportJobs, reportProjects, reportShifts } from "./reportQueries";

vi.mock("../../lib/api", () => ({ listProjectsAnyStatus: vi.fn(async () => []) }));
vi.mock("../../lib/timeclock", () => ({ listTeamShifts: vi.fn(async () => []) }));
vi.mock("../../lib/signedIn", () => ({ signInMark: () => ({ userId: "owner", generation: 1 }) }));
import { listTeamShifts } from "../../lib/timeclock";
import { listProjectsAnyStatus } from "../../lib/api";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); focusManager.setFocused(undefined); onlineManager.setOnline(true); });

it("canonicalizes compatible scopes, separates owners and windows, and disables empty/invalid scopes", async () => {
  const a = reportShifts("a", ["b", "a", "a"], 1000, 2000, true);
  expect(a.queryKey).toEqual(reportShifts("a", ["a", "b"], 1000, 2000, true).queryKey);
  expect(a.queryKey).not.toEqual(reportShifts("b", ["a", "b"], 1000, 2000, true).queryKey);
  expect(a.queryKey).not.toEqual(reportShifts("a", ["a", "b"], 0, 2000, true).queryKey);
  const signal = new AbortController().signal;
  await a.queryFn({ signal });
  expect(listTeamShifts).toHaveBeenCalledWith(new Date(1000).toISOString(), new Date(2000).toISOString(), undefined, { projectIds: ["a", "b"], signal });
  expect(reportShifts("a", [], 0, 1, true).enabled).toBe(false);
  expect(reportShifts("a", null, 2, 1, true).enabled).toBe(false);
  expect(reportShifts("a", null, 0, 1, false).enabled).toBe(false);
});

it("shares compatible caches, pauses hidden observers, and automatically revalidates stale history", async () => {
  vi.useFakeTimers();
  const client = new QueryClient(); const unmount = client.mount.bind(client); unmount();
  const first = new QueryObserver(client, reportProjects("owner", true));
  const stopFirst = first.subscribe(() => {});
  await vi.waitFor(() => expect(first.getCurrentResult().isSuccess).toBe(true));
  const second = new QueryObserver(client, reportProjects("owner", false));
  const stopSecond = second.subscribe(() => {});
  first.setOptions(reportProjects("owner", false));
  second.setOptions(reportProjects("owner", true));
  await vi.advanceTimersByTimeAsync(120_000);
  focusManager.setFocused(false); focusManager.setFocused(true);
  onlineManager.setOnline(false); onlineManager.setOnline(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(listProjectsAnyStatus).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300_000);
  focusManager.setFocused(false); focusManager.setFocused(true);
  await vi.waitFor(() => expect(listProjectsAnyStatus).toHaveBeenCalledTimes(2));
  first.setOptions(reportProjects("owner", false)); second.setOptions(reportProjects("owner", false));
  await client.invalidateQueries({ queryKey: ["dataReview", "owner"] });
  expect(listProjectsAnyStatus).toHaveBeenCalledTimes(2);
  stopFirst(); stopSecond(); client.unmount(); client.clear();
});

it("cancels an outstanding scoped request on a tab switch", async () => {
  const client = new QueryClient(); let aborted = false;
  vi.mocked(listTeamShifts).mockImplementationOnce((_from, _until, _person, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
  }));
  const observer = new QueryObserver(client, reportShifts("owner", ["job"], 0, 1000, true));
  const stop = observer.subscribe(() => {});
  await client.cancelQueries({ queryKey: ["dataReview", "owner"] });
  expect(aborted).toBe(true);
  expect(client.getQueryData(observer.options.queryKey!)).toBeUndefined();
  stop(); client.clear();
});

it("stops Current's queued job fanout after cancellation", async () => {
  const controller = new AbortController();
  const read = vi.fn(async (job: string) => { controller.abort(); return job; });
  await expect(mapReportJobs(["first", "second"], read, true, controller.signal)).rejects.toThrow();
  expect(read.mock.calls).toEqual([["first"]]);
});

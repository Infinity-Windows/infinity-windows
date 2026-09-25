// Keeping the next few days' toolbox talks on the phone (offline toolbox
// signing, 2026-09-25), so a phone that last had signal yesterday — or on
// Friday — can still sign this morning's talk with none.

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTalkForDate = vi.fn();
vi.mock("./ops", () => ({ getTalkForDate: (d: string) => getTalkForDate(d) }));

const { TALK_DAYS_AHEAD, prefetchToolboxTalks, shouldPrefetchTalks, talkDatesAhead } = await import("./toolboxAhead");

beforeEach(() => {
  getTalkForDate.mockReset();
  getTalkForDate.mockImplementation(async (d: string) => ({ id: `talk-${d}`, title: `Talk for ${d}`, body: "b", talk_date: d }));
});

describe("which days", () => {
  it("covers a whole weekend: last signal on Friday, signing Monday morning", () => {
    expect(TALK_DAYS_AHEAD).toBe(4);
    expect(talkDatesAhead(new Date(2026, 8, 25, 16, 30))).toEqual([
      "2026-09-25", // Friday
      "2026-09-26",
      "2026-09-27",
      "2026-09-28", // Monday
    ]);
  });

  it("walks across a month and a year on the phone's own calendar", () => {
    expect(talkDatesAhead(new Date(2026, 11, 30, 23, 59))).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });
});

describe("keeping them on the phone", () => {
  function client() {
    return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  }

  it("keeps each day's talk under that day's own key", async () => {
    const qc = client();
    await prefetchToolboxTalks(qc, new Date(2026, 8, 25, 6));
    for (const d of ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"]) {
      expect(qc.getQueryData(["toolboxTalk", d])).toMatchObject({ id: `talk-${d}`, talk_date: d });
    }
    expect(getTalkForDate).toHaveBeenCalledTimes(4);
  });

  it("keeps the days it could read when one of them fails, and never throws", async () => {
    const qc = client();
    getTalkForDate.mockImplementation(async (d: string) => {
      if (d === "2026-09-26") throw new TypeError("Failed to fetch");
      return { id: `talk-${d}`, title: "t", body: "b", talk_date: d };
    });
    await expect(prefetchToolboxTalks(qc, new Date(2026, 8, 25, 6))).resolves.toBeUndefined();
    expect(qc.getQueryData(["toolboxTalk", "2026-09-25"])).toBeTruthy();
    expect(qc.getQueryData(["toolboxTalk", "2026-09-26"])).toBeUndefined();
    expect(qc.getQueryData(["toolboxTalk", "2026-09-28"])).toBeTruthy();
  });

  it("keeps a day with no talk as exactly that", async () => {
    const qc = client();
    getTalkForDate.mockResolvedValue(null);
    await prefetchToolboxTalks(qc, new Date(2026, 8, 25, 6));
    expect(qc.getQueryData(["toolboxTalk", "2026-09-27"])).toBeNull();
  });

  it("does not read a day again that it read a moment ago", async () => {
    const qc = client();
    const at = new Date(2026, 8, 25, 6);
    await prefetchToolboxTalks(qc, at);
    await prefetchToolboxTalks(qc, at);
    expect(getTalkForDate).toHaveBeenCalledTimes(4);
  });
});

describe("when to fetch", () => {
  const nine = new Date(2026, 8, 25, 9).getTime();

  it("the first time, and only with signal", () => {
    expect(shouldPrefetchTalks({ online: true, lastRunAt: null, lastRunDay: null, now: nine })).toBe(true);
    expect(shouldPrefetchTalks({ online: false, lastRunAt: null, lastRunDay: null, now: nine })).toBe(false);
  });

  it("not again within half an hour on the same day", () => {
    const last = nine - 10 * 60_000;
    expect(shouldPrefetchTalks({ online: true, lastRunAt: last, lastRunDay: "2026-09-25", now: nine })).toBe(false);
    expect(shouldPrefetchTalks({ online: true, lastRunAt: nine - 31 * 60_000, lastRunDay: "2026-09-25", now: nine })).toBe(true);
  });

  it("at once on a new day, however recent the last read", () => {
    const justAfterMidnight = new Date(2026, 8, 26, 0, 1).getTime();
    expect(
      shouldPrefetchTalks({ online: true, lastRunAt: justAfterMidnight - 5 * 60_000, lastRunDay: "2026-09-25", now: justAfterMidnight }),
    ).toBe(true);
  });
});

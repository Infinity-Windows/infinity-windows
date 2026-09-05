// @vitest-environment happy-dom
//
// The memory that stops the post-clock-out offer becoming nagging. A foreman
// who clocks in and out of the same job three times gets asked once, and a
// nudge that comes back every time is one people learn to dismiss unread.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOCKED_OUT_EVENT,
  alreadyAskedToday,
  announceClockedOut,
  rememberAskedToday,
  type ClockedOutDetail,
} from "./dailyLogNudge";

const KEY = "infinity.dailyLogNudge.asked";
const TODAY = "2026-09-05";
const TOMORROW = "2026-09-06";

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clean up */
  }
});

describe("asking once per job per day", () => {
  it("has not asked before it asks", () => {
    expect(alreadyAskedToday("black22", TODAY)).toBe(false);
  });

  it("does not ask twice about the same job on the same day", () => {
    rememberAskedToday("black22", TODAY);
    expect(alreadyAskedToday("black22", TODAY)).toBe(true);
  });

  it("still asks about a different job the same day", () => {
    rememberAskedToday("black22", TODAY);
    expect(alreadyAskedToday("pecan14", TODAY)).toBe(false);
  });

  it("asks again tomorrow — a new day is a new log", () => {
    rememberAskedToday("black22", TODAY);
    expect(alreadyAskedToday("black22", TOMORROW)).toBe(false);
  });

  it("remembers several jobs on one day", () => {
    rememberAskedToday("black22", TODAY);
    rememberAskedToday("pecan14", TODAY);
    expect(alreadyAskedToday("black22", TODAY)).toBe(true);
    expect(alreadyAskedToday("pecan14", TODAY)).toBe(true);
  });

  it("throws yesterday's record away instead of growing forever", () => {
    rememberAskedToday("black22", TODAY);
    rememberAskedToday("pecan14", TOMORROW);
    const stored = JSON.parse(localStorage.getItem(KEY)!) as { projectIds: string[] };
    expect(stored.projectIds).toEqual(["pecan14"]);
  });
});

describe("a browser that will not remember, or remembers junk", () => {
  it("treats unreadable storage as 'not asked yet' — asking once more is harmless", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    expect(alreadyAskedToday("black22", TODAY)).toBe(false);
  });

  it("ignores a value somebody else wrote under the key", () => {
    localStorage.setItem(KEY, '{"nope":true}');
    expect(alreadyAskedToday("black22", TODAY)).toBe(false);
  });

  it("does not lose the clock-out over a failed write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => rememberAskedToday("black22", TODAY)).not.toThrow();
  });
});

describe("announceClockedOut", () => {
  it("carries the job the shift was on", async () => {
    const seen: (string | null)[] = [];
    const listener = (e: Event) => {
      seen.push((e as CustomEvent<ClockedOutDetail>).detail.projectId);
    };
    window.addEventListener(CLOCKED_OUT_EVENT, listener);
    announceClockedOut("black22");
    // An overarching clock-in has no job, and therefore no log to file.
    announceClockedOut(null);
    window.removeEventListener(CLOCKED_OUT_EVENT, listener);
    expect(seen).toEqual(["black22", null]);
  });
});

// @vitest-environment happy-dom
//
// localStorage is the whole subject here, so this needs a DOM — the same
// reason featureTips.test.ts and clockSkew.test.ts ask for one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLastCaptureJob, writeLastCaptureJob } from "./lastJob";

const KEY = "infinity.capture.lastJob";

afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clean up */
  }
});

describe("the last job captured to", () => {
  it("comes back after it is written", () => {
    writeLastCaptureJob("black22");
    expect(readLastCaptureJob()).toBe("black22");
  });

  it("is null on a device that has never captured", () => {
    expect(readLastCaptureJob()).toBeNull();
  });

  it("ignores a blank value rather than offering an empty chip", () => {
    localStorage.setItem(KEY, "   ");
    expect(readLastCaptureJob()).toBeNull();
  });

  it("does not record 'no job' — that is an answer, not a job to offer again", () => {
    writeLastCaptureJob("black22");
    writeLastCaptureJob(null);
    expect(readLastCaptureJob()).toBe("black22");
  });
});

// A private window, a locked-down browser and a full quota all throw on plain
// localStorage access. A capture sheet that cannot remember must still open.
describe("a browser that refuses to remember", () => {
  it("reads null instead of throwing", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    expect(() => readLastCaptureJob()).not.toThrow();
    expect(readLastCaptureJob()).toBeNull();
  });

  it("swallows a failed write instead of losing the tap that caused it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => writeLastCaptureJob("black22")).not.toThrow();
  });
});

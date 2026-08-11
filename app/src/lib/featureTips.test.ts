// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissTip,
  isTipDismissed,
  resetSessionTips,
  skipTip,
  tipKeyForRoute,
} from "./featureTips";

beforeEach(() => {
  localStorage.clear();
  resetSessionTips();
});

describe("skip", () => {
  it("stays hidden for the session but does not persist", () => {
    skipTip("projects");
    expect(isTipDismissed("projects")).toBe(true);
    expect(localStorage.getItem("infinity:dismissed-tips")).toBeNull();
    // Next launch (fresh session memory): back again, by design.
    resetSessionTips();
    expect(isTipDismissed("projects")).toBe(false);
  });
});

describe("don't show again", () => {
  it("persists across sessions", () => {
    dismissTip("projects");
    resetSessionTips();
    expect(isTipDismissed("projects")).toBe(true);
  });

  it("silences every role variant of the landing tip at once", () => {
    dismissTip("home");
    expect(isTipDismissed("home_installer")).toBe(true);
    resetSessionTips();
    expect(isTipDismissed("home_installer")).toBe(true);

    localStorage.clear();
    resetSessionTips();
    dismissTip("home_installer");
    expect(isTipDismissed("home")).toBe(true);
  });

  it("still holds for the whole session when storage writes fail", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    dismissTip("projects");
    expect(isTipDismissed("projects")).toBe(true);
    spy.mockRestore();
  });
});

describe("tipKeyForRoute", () => {
  it("routes the landing tip by role", () => {
    expect(tipKeyForRoute("/", "installer")).toBe("home_installer");
    expect(tipKeyForRoute("/", "owner")).toBe("home");
  });
});

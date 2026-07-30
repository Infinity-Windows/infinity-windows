import { describe, expect, it, vi } from "vitest";
import { PlanLoadTimeout, planLoadMessage, withPlanTimeout } from "./planLoad";

describe("withPlanTimeout", () => {
  it("passes a value through untouched", async () => {
    await expect(withPlanTimeout(Promise.resolve("plan"), 50)).resolves.toBe("plan");
  });

  it("passes a rejection through untouched", async () => {
    await expect(withPlanTimeout(Promise.reject(new Error("nope")), 50)).rejects.toThrow(
      "nope",
    );
  });

  /**
   * The failure this exists for. A pdf.js worker that never answers leaves a
   * promise that neither resolves nor rejects, which is what left the panel on
   * "Loading original plan…" until the app was closed.
   */
  it("rejects a promise that never settles", async () => {
    vi.useFakeTimers();
    try {
      const forever = new Promise<string>(() => {});
      const raced = withPlanTimeout(forever, 45_000);
      const assertion = expect(raced).rejects.toBeInstanceOf(PlanLoadTimeout);
      await vi.advanceTimersByTimeAsync(45_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer on success so nothing fires later", async () => {
    vi.useFakeTimers();
    try {
      await withPlanTimeout(Promise.resolve(1), 1000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("planLoadMessage", () => {
  /**
   * The exact string an installer saw on an iPhone where the plan should have
   * been. It must never reach a field user again.
   */
  it("never shows the WebKit for-await TypeError to a crew member", () => {
    const real = new TypeError("undefined is not a function (near '...e of t...')");
    const text = planLoadMessage(real);
    expect(text).not.toContain("undefined is not a function");
    expect(text).not.toContain("e of t");
    expect(text).toContain("Retry");
  });

  it("says the wait ran out when it timed out", () => {
    expect(planLoadMessage(new PlanLoadTimeout(45_000))).toContain("taking too long");
  });

  it("keeps a real, readable API failure", () => {
    expect(
      planLoadMessage({ message: "permission denied for table project_plansets" }),
    ).toContain("permission denied");
  });

  it("always returns something a person can read", () => {
    for (const value of [null, undefined, {}, "", new TypeError("x is not a function")]) {
      const text = planLoadMessage(value);
      expect(text.trim()).not.toBe("");
      expect(text).not.toContain("[object Object]");
    }
  });
});

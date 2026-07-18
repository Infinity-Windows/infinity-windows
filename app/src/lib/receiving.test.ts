import { describe, expect, it } from "vitest";
import { computeDeliveryProgress } from "./receiving";
import type { WindowStatus } from "./types";

const unit = (status: WindowStatus) => ({ status });

describe("computeDeliveryProgress", () => {
  it("counts every pre_issued unit as still awaiting arrival", () => {
    const p = computeDeliveryProgress([
      unit("pre_issued"),
      unit("pre_issued"),
      unit("pre_issued"),
    ]);
    expect(p).toEqual({
      expected: 3,
      received: 0,
      preIssuedRemaining: 3,
      damaged: 0,
    });
  });

  it("treats any non-pre_issued status as received", () => {
    const p = computeDeliveryProgress([
      unit("pre_issued"),
      unit("in_warehouse"),
      unit("staged"),
      unit("loaded"),
      unit("installed"),
    ]);
    expect(p.expected).toBe(5);
    expect(p.received).toBe(4);
    expect(p.preIssuedRemaining).toBe(1);
  });

  it("counts damaged units as both received and damaged (held)", () => {
    const p = computeDeliveryProgress([
      unit("in_warehouse"),
      unit("damaged"),
      unit("pre_issued"),
    ]);
    expect(p.received).toBe(2);
    expect(p.damaged).toBe(1);
    expect(p.preIssuedRemaining).toBe(1);
  });

  it("is all-zero for a project with no tracked units", () => {
    expect(computeDeliveryProgress([])).toEqual({
      expected: 0,
      received: 0,
      preIssuedRemaining: 0,
      damaged: 0,
    });
  });

  it("reports full receipt when nothing remains pre_issued", () => {
    const p = computeDeliveryProgress([
      unit("in_warehouse"),
      unit("in_warehouse"),
    ]);
    expect(p.preIssuedRemaining).toBe(0);
    expect(p.received).toBe(p.expected);
  });
});

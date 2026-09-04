import { describe, expect, it } from "vitest";
import {
  STILL_HERE_HOLD_MS,
  describeMiles,
  holdKey,
  isJobCostCode,
  milesFromMeters,
  shouldAskAboutTravel,
  type TravelPromptShift,
} from "./farFromJob";

// Mad Moose and a supply house ~14 miles north of it, in real coordinates.
const JOB = { lat: 40.76, lng: -111.89 };
const FAR = { lat: 40.96, lng: -111.89, accuracyM: 20 };
const NEAR = { lat: 40.7605, lng: -111.8905, accuracyM: 20 };

function shift(over: Partial<TravelPromptShift> = {}): TravelPromptShift {
  return {
    status: "open",
    project_id: "job-1",
    cost_codes: { code: "100" },
    ...over,
  };
}

describe("isJobCostCode", () => {
  it("treats Travel 900 as not job work", () => {
    expect(isJobCostCode("900")).toBe(false);
    expect(isJobCostCode(" 900 ")).toBe(false);
  });

  it("treats every other code, and an absent one, as job work", () => {
    expect(isJobCostCode("100")).toBe(true);
    expect(isJobCostCode(null)).toBe(true);
    expect(isJobCostCode(undefined)).toBe(true);
  });
});

describe("shouldAskAboutTravel", () => {
  it("asks when a job punch is far from where the job's clock-ins happen", () => {
    expect(
      shouldAskAboutTravel({ shift: shift(), myFix: FAR, jobGeo: JOB }),
    ).toBe(true);
  });

  it("says nothing when the phone is at the job", () => {
    expect(
      shouldAskAboutTravel({ shift: shift(), myFix: NEAR, jobGeo: JOB }),
    ).toBe(false);
  });

  it("never asks somebody already on Travel", () => {
    expect(
      shouldAskAboutTravel({
        shift: shift({ cost_codes: { code: "900" } }),
        myFix: FAR,
        jobGeo: JOB,
      }),
    ).toBe(false);
  });

  it("never asks a shift that is not on the clock", () => {
    for (const status of ["needs_finish", "submitted", "approved", "voided"]) {
      expect(
        shouldAskAboutTravel({ shift: shift({ status }), myFix: FAR, jobGeo: JOB }),
      ).toBe(false);
    }
  });

  it("never asks a punch with no job to be away from", () => {
    expect(
      shouldAskAboutTravel({
        shift: shift({ project_id: null }),
        myFix: FAR,
        jobGeo: JOB,
      }),
    ).toBe(false);
  });

  it("is silent while an 'I'm still here' hold is running, and asks after it", () => {
    const now = 1_000_000;
    expect(
      shouldAskAboutTravel({
        shift: shift(),
        myFix: FAR,
        jobGeo: JOB,
        heldUntilMs: now + STILL_HERE_HOLD_MS,
        now,
      }),
    ).toBe(false);
    expect(
      shouldAskAboutTravel({
        shift: shift(),
        myFix: FAR,
        jobGeo: JOB,
        heldUntilMs: now - 1,
        now,
      }),
    ).toBe(true);
  });

  it("is silent whenever anything is unknown", () => {
    expect(shouldAskAboutTravel({ shift: null, myFix: FAR, jobGeo: JOB })).toBe(false);
    expect(shouldAskAboutTravel({ shift: shift(), myFix: null, jobGeo: JOB })).toBe(false);
    expect(shouldAskAboutTravel({ shift: shift(), myFix: FAR, jobGeo: null })).toBe(false);
    // A fix fuzzier than the threshold cannot tell near from far.
    expect(
      shouldAskAboutTravel({
        shift: shift(),
        myFix: { ...FAR, accuracyM: 5_000 },
        jobGeo: JOB,
      }),
    ).toBe(false);
  });
});

describe("describeMiles", () => {
  it("rounds to whole miles past one", () => {
    expect(describeMiles(13.7)).toEqual({ value: "14", one: false });
    expect(describeMiles(1.2)).toEqual({ value: "1", one: true });
  });

  it("keeps a tenth below a mile and never says zero", () => {
    expect(describeMiles(0.62)).toEqual({ value: "0.6", one: false });
    expect(describeMiles(0.01)).toEqual({ value: "0.1", one: false });
    expect(describeMiles(0)).toEqual({ value: "0.1", one: false });
    expect(describeMiles(Number.NaN)).toEqual({ value: "0.1", one: false });
  });
});

describe("milesFromMeters", () => {
  it("converts a mile to a mile", () => {
    expect(milesFromMeters(1609.344)).toBeCloseTo(1, 6);
    expect(milesFromMeters(800)).toBeCloseTo(0.497, 3);
  });
});

describe("holdKey", () => {
  it("is per shift, so a new punch asks again", () => {
    expect(holdKey("a")).not.toBe(holdKey("b"));
    expect(holdKey("a")).toContain("a");
  });
});

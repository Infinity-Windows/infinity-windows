import { describe, expect, it } from "vitest";
import {
  isMissingStagingBayError,
  missingBayMessage,
  missingStagingBayJobCode,
  missingStagingSlots,
  NO_STAGING_BAY_HINT,
  plainSuggestion,
  sharedShelfWarning,
  stagingBaysFor,
} from "./staging";
import type { Location } from "./types";

const loc = (over: Partial<Location>): Location => ({
  id: over.address ?? "id",
  zone: "S",
  rack: "01",
  slot: "A",
  address: "S-01-A",
  capacity: 6,
  active: true,
  ...over,
});

const bay = (jobCode: string, slot: string, active = true) =>
  loc({
    id: `J-${jobCode}-${slot}`,
    zone: "J",
    rack: jobCode,
    slot,
    address: `J-${jobCode}-${slot}`,
    capacity: 10,
    active,
  });

describe("recognising the database's refusal", () => {
  it("keys on the hint, not on the wording of the message", () => {
    // The message is written for a foreman and will get reworded. The hint is
    // the contract, so it is what the client matches on.
    const err = {
      code: "P0001",
      message: "Job BLACK22 has no staging bay, so there is no shelf …",
      hint: NO_STAGING_BAY_HINT,
      details: "BLACK22",
    };
    expect(isMissingStagingBayError(err)).toBe(true);
    expect(missingStagingBayJobCode(err)).toBe("BLACK22");
  });

  it("does not mistake another database error for a missing bay", () => {
    expect(
      isMissingStagingBayError({ code: "P0001", message: "unknown window x" }),
    ).toBe(false);
    expect(isMissingStagingBayError(new Error("Failed to fetch"))).toBe(false);
    expect(isMissingStagingBayError(null)).toBe(false);
  });

  it("copes with a refusal that carried no job code", () => {
    expect(missingStagingBayJobCode({ hint: NO_STAGING_BAY_HINT, details: "" })).toBe(
      null,
    );
    expect(missingBayMessage(null)).toContain("This job has no staging bay");
    expect(missingBayMessage("PECAN14")).toContain("Job PECAN14");
  });
});

describe("a suggestion that is not the job's own bay", () => {
  it("warns when a job's window is sent to a shared stock shelf", () => {
    const warning = sharedShelfWarning(true, loc({ address: "S-01-C" }));
    expect(warning).toContain("S-01-C");
    expect(warning).toContain("shared stock shelf");
  });

  it("says nothing when the suggestion is the job's own bay", () => {
    expect(sharedShelfWarning(true, bay("BLACK22", "A"))).toBe(null);
  });

  it("says nothing for unassigned stock, which belongs on a stock shelf", () => {
    expect(sharedShelfWarning(false, loc({ address: "S-01-C" }))).toBe(null);
  });

  it("says nothing when there is no suggestion at all", () => {
    expect(sharedShelfWarning(true, null)).toBe(null);
    expect(plainSuggestion(null)).toEqual({
      location: null,
      warning: null,
      missingBay: false,
      jobCode: null,
    });
  });
});

describe("spotting a job whose bays are missing", () => {
  const stock = [loc({ address: "S-01-A" }), loc({ address: "S-01-B" })];

  it("finds both bays for a job that has them", () => {
    const all = [...stock, bay("BLACK22", "B"), bay("BLACK22", "A")];
    expect(stagingBaysFor(all, "BLACK22").map((l) => l.address)).toEqual([
      "J-BLACK22-A",
      "J-BLACK22-B",
    ]);
    expect(missingStagingSlots(all, "BLACK22")).toEqual([]);
  });

  it("reports both slots for a job with no bays at all", () => {
    expect(missingStagingSlots(stock, "BLACK22")).toEqual(["A", "B"]);
  });

  it("counts a retired bay as missing, because pickers never show it", () => {
    const all = [...stock, bay("BLACK22", "A"), bay("BLACK22", "B", false)];
    expect(missingStagingSlots(all, "BLACK22")).toEqual(["B"]);
  });

  it("does not confuse one job's bays with another's", () => {
    const all = [bay("OAKRIDGE", "A"), bay("OAKRIDGE", "B")];
    expect(missingStagingSlots(all, "BLACK22")).toEqual(["A", "B"]);
    expect(stagingBaysFor(all, "BLACK22")).toEqual([]);
  });

  it("has nothing to say before the job code is known", () => {
    expect(stagingBaysFor([bay("BLACK22", "A")], null)).toEqual([]);
    expect(missingStagingSlots([bay("BLACK22", "A")], undefined)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { jobLabel, pieceLine, type StoragePackage } from "../storage";

const codes = new Map([["job-1", "BLACK22"]]);
const p = (over: Partial<StoragePackage>) =>
  ({ status: "received", project_id: "job-1", ...over }) as StoragePackage;

describe("who owns a package, in words (ticket 17)", () => {
  it("a job on the list reads by its code", () => {
    expect(jobLabel(p({}), codes)).toBe("BLACK22");
  });

  it("a bound package with no job is the Boneyard, on purpose", () => {
    expect(jobLabel(p({ project_id: null }), codes)).toBe("Boneyard");
  });

  it("a finished job's package is NEVER adopted by the Boneyard", () => {
    // The job exists — it just isn't in an active-jobs map. Calling this
    // Boneyard would rename audit F9 instead of fixing it.
    expect(jobLabel(p({ project_id: "job-done" }), codes)).toBe("job not listed");
  });

  it("a blank sticker owns nothing and says nothing", () => {
    expect(jobLabel(p({ status: "blank", project_id: null }), codes)).toBe("");
  });
});

describe("what a picker row calls a package (owner ask, 2026-08-18)", () => {
  type Piece = Parameters<typeof pieceLine>[0];
  const base: Piece = { part_index: null, part_total: null, part_type: null };

  it("window, fraction and piece, in that order", () => {
    expect(
      pieceLine({
        ...base,
        package_marks: [{ mark_code: "6" }],
        part_index: 1,
        part_total: 4,
        part_type: "frame",
      }),
    ).toBe("#6 1/4 · Frame");
  });

  it("degrades honestly at every step", () => {
    expect(pieceLine({ ...base, package_marks: [{ mark_code: "6" }] })).toBe("#6");
    expect(pieceLine({ ...base, part_index: 2, part_total: 4 })).toBe("2/4");
    expect(pieceLine({ ...base, part_type: "glass" })).toBe("Glass");
    expect(pieceLine(base)).toBe(null);
  });
});

import { describe, expect, it } from "vitest";
import { jobLabel, type StoragePackage } from "../storage";

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

// Quick tracking job — the two decisions that must be right BEFORE the write:
// what a nameless job is called, and whether one is already open to join
// (standard-tracking-jobs slice 5).

import { describe, expect, it } from "vitest";
import { matchingTrackingJobs, quickJobName, quickTrackingJobCode } from "./quickJobs";
import type { Project } from "./types";

function job(over: Partial<Project> = {}): Project {
  return {
    id: over.id ?? "p1",
    job_code: over.job_code ?? "JOB1",
    name: over.name ?? "A job",
    address: over.address ?? null,
    status: over.status ?? "active",
    allowed_modes: over.allowed_modes ?? ["tracking"],
    deleted_at: over.deleted_at ?? null,
    ...over,
  };
}

describe("quickJobName", () => {
  it("uses the typed name when there is one", () => {
    expect(quickJobName({ name: "Warranty callback", address: "123 Main" })).toBe(
      "Warranty callback",
    );
  });

  it("falls back to the address when the name is blank", () => {
    expect(quickJobName({ name: "  ", address: "123 Main St" })).toBe("123 Main St");
  });

  it("falls back to the customer when name and address are both blank", () => {
    expect(quickJobName({ address: "", customerName: "Ortega" })).toBe("Ortega");
  });

  it("has a last-resort label so createProject never gets a blank name", () => {
    expect(quickJobName({})).toBe("Tracking job");
  });
});

describe("quickTrackingJobCode", () => {
  it("derives an uppercase, dash-safe base (capped) from the name plus the suffix", () => {
    // The base is capped at 16 chars so job_code stays short in staging-bay
    // addresses; the random suffix keeps it unique regardless.
    expect(quickTrackingJobCode("123 Main St — Warranty", "AB12")).toBe(
      "123-MAIN-ST-WARR-AB12",
    );
    expect(quickTrackingJobCode("Warranty", "AB12")).toBe("WARRANTY-AB12");
  });

  it("emits only characters createProject's sanitiser leaves untouched", () => {
    const code = quickTrackingJobCode("Señor O'Brien #4!!", "ZZ99");
    expect(code).toMatch(/^[A-Z0-9-]+$/);
    expect(code.endsWith("-ZZ99")).toBe(true);
  });

  it("never produces a blank base", () => {
    expect(quickTrackingJobCode("!!!", "QQ00")).toBe("JOB-QQ00");
  });

  it("gives a different code each call by default (unique job_code)", () => {
    expect(quickTrackingJobCode("Same name")).not.toBe(quickTrackingJobCode("Same name"));
  });
});

describe("matchingTrackingJobs (de-dupe)", () => {
  it("surfaces an open tracking job whose name matches what's typed", () => {
    const jobs = [job({ id: "a", name: "Warranty callback", allowed_modes: ["tracking"] })];
    const matches = matchingTrackingJobs(jobs, "warranty", "");
    expect(matches.map((m) => m.id)).toEqual(["a"]);
  });

  it("matches on address too", () => {
    const jobs = [job({ id: "a", name: "Callback", address: "123 Main St" })];
    expect(matchingTrackingJobs(jobs, "", "123 main").map((m) => m.id)).toEqual(["a"]);
  });

  it("ignores data-only jobs — a data job is never a quick tracking job", () => {
    const jobs = [job({ id: "d", name: "Warranty", allowed_modes: ["data"] })];
    expect(matchingTrackingJobs(jobs, "warranty", "")).toEqual([]);
  });

  it("ignores finished and trashed jobs", () => {
    const jobs = [
      job({ id: "done", name: "Warranty", status: "completed" }),
      job({ id: "gone", name: "Warranty", deleted_at: "2026-09-01T00:00:00Z" }),
    ];
    expect(matchingTrackingJobs(jobs, "warranty", "")).toEqual([]);
  });

  it("does not match on a one-character scrap, and returns nothing for empty input", () => {
    const jobs = [job({ id: "a", name: "Aardvark" })];
    expect(matchingTrackingJobs(jobs, "a", "")).toEqual([]);
    expect(matchingTrackingJobs(jobs, "", "")).toEqual([]);
  });

  it("matches when the typed value contains the job name (either direction)", () => {
    const jobs = [job({ id: "a", name: "Main St" })];
    expect(matchingTrackingJobs(jobs, "123 Main St unit 4", "").map((m) => m.id)).toEqual([
      "a",
    ]);
  });
});

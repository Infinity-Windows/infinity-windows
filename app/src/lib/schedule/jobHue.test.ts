import { describe, expect, it } from "vitest";
import { assignmentJobHue, calendarColorStyle, jobHue } from "./jobHue";

/**
 * Wave C: the calendar's color law is job identity, never stored — the
 * same project id has to land on the same one of 12 evenly spaced hues
 * every time, everywhere it's drawn, and the 12 buckets have to actually
 * get used rather than collapsing onto a handful. Mirrors
 * storage.test.ts's containerHue suite, the pattern this hash follows.
 */
describe("jobHue", () => {
  it("is stable for the same project id", () => {
    expect(jobHue("proj-0007")).toBe(jobHue("proj-0007"));
  });

  it("gives two different ids no guaranteed relationship, but is still a pure function of the string", () => {
    const a = jobHue("proj-0001");
    const b = jobHue("proj-0001");
    const c = jobHue("Black Desert Lot 22");
    expect(a).toBe(b);
    expect(typeof c).toBe("number");
  });

  it("only ever returns one of the 12 evenly spaced hues", () => {
    const allowed = new Set(Array.from({ length: 12 }, (_, i) => i * 30));
    for (let i = 0; i < 60; i++) {
      expect(allowed.has(jobHue(`proj-${String(i).padStart(6, "0")}`))).toBe(true);
    }
  });

  it("spreads a batch of ordinary uuid-shaped ids across all 12 buckets", () => {
    const hues = new Set(
      Array.from({ length: 60 }, (_, i) =>
        jobHue(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`),
      ),
    );
    expect(hues.size).toBe(12);
  });

  // A row read before some future column existed, or a test fixture that
  // never set an id, must still render a hue, not crash the page it's
  // coloring — the same guard containerHue carries (storage.ts), caught
  // live there by an e2e fixture with no `serial`.
  it("never throws on a missing or non-string id", () => {
    expect(() => jobHue(undefined as unknown as string)).not.toThrow();
    expect(() => jobHue(null as unknown as string)).not.toThrow();
    expect(typeof jobHue(undefined as unknown as string)).toBe("number");
  });
});

describe("assignmentJobHue", () => {
  it("is the job's hue for an install assignment", () => {
    expect(assignmentJobHue({ project_id: "proj-1" })).toBe(jobHue("proj-1"));
  });

  it("is null for a delivery — no single job to name (project_id is always null)", () => {
    expect(assignmentJobHue({ project_id: null })).toBeNull();
  });
});

describe("calendarColorStyle", () => {
  it("honors an explicit per-block override, unchanged by the color law", () => {
    expect(calendarColorStyle({ project_id: "proj-1", color: "#123456" })).toEqual({
      "--sched-color": "#123456",
    });
  });

  it("falls back to the job's hue when there is no override", () => {
    expect(calendarColorStyle({ project_id: "proj-1", color: null })).toEqual({
      "--job-hue": jobHue("proj-1"),
    });
  });

  it("sets neither var for an un-overridden delivery — no job to guess a color from", () => {
    expect(calendarColorStyle({ project_id: null, color: null })).toEqual({});
  });

  it("still honors an override on a delivery (a dispatcher can still pick one)", () => {
    expect(calendarColorStyle({ project_id: null, color: "#abcdef" })).toEqual({
      "--sched-color": "#abcdef",
    });
  });
});

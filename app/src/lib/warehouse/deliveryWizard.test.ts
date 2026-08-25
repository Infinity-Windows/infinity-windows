import { describe, expect, it } from "vitest";
import {
  buildDeliveryPayload,
  describeSet,
  emptyEntry,
  emptySet,
  normalizeMark,
  wizardProblems,
  type WizardEntry,
} from "./deliveryWizard";

const entry = (over: Partial<WizardEntry> = {}): WizardEntry => ({
  project_id: "p-1",
  job_name: "",
  sets: [{ mark: "16", kind: "window", package_count: 3, crate: null }],
  ...over,
});

describe("wizardProblems", () => {
  it("passes a clean skeleton", () => {
    expect(wizardProblems([entry()])).toEqual([]);
  });

  it("requires a job pick or a typed name — but a typed name alone is fine (owner: never block the unload)", () => {
    expect(wizardProblems([entry({ project_id: null, job_name: "" })])).toContain(
      "Job 1: pick a job or type its name.",
    );
    expect(
      wizardProblems([entry({ project_id: null, job_name: "Sunset Ridge 4" })]),
    ).toEqual([]);
  });

  it("catches empty marks, duplicates, and package counts out of range", () => {
    const problems = wizardProblems([
      entry({
        sets: [
          { mark: "", kind: "window", package_count: 0, crate: null },
          { mark: "#16", kind: "door", package_count: 3, crate: null },
          { mark: "16", kind: "window", package_count: 21, crate: null },
        ],
      }),
    ]);
    expect(problems.some((p) => p.includes("needs a mark"))).toBe(true);
    expect(problems.some((p) => p.includes("listed twice"))).toBe(true);
    expect(problems.some((p) => p.includes("1 to 20 packages"))).toBe(true);
  });

  it("crates need a name and a sane piece count", () => {
    const problems = wizardProblems([
      entry({
        sets: [
          {
            mark: "14",
            kind: "window",
            package_count: 3,
            crate: { name: " ", pieces: 0, part_type: "glass" },
          },
        ],
      }),
    ]);
    expect(problems.some((p) => p.includes("name the crate"))).toBe(true);
    expect(problems.some((p) => p.includes("crate pieces"))).toBe(true);
  });

  it("caps jobs at 17 and sets at 50", () => {
    const many = Array.from({ length: 18 }, () => entry());
    expect(wizardProblems(many).some((p) => p.includes("at most 17"))).toBe(true);
    const wide = entry({
      sets: Array.from({ length: 51 }, (_, i) => ({
        mark: String(i + 1),
        kind: "window" as const,
        package_count: 1,
        crate: null,
      })),
    });
    expect(wizardProblems([wide]).some((p) => p.includes("at most 50 sets"))).toBe(true);
  });
});

describe("buildDeliveryPayload", () => {
  it("normalizes marks, nulls the unused name/id side, defaults crate glass", () => {
    const payload = buildDeliveryPayload([
      entry({
        sets: [
          {
            mark: " #16 ",
            kind: "window",
            package_count: 3,
            crate: { name: " Crate 1 ", pieces: 4, part_type: " " },
          },
        ],
      }),
      entry({ project_id: null, job_name: " Sunset Ridge 4 " }),
    ]) as Array<Record<string, unknown>>;
    expect(payload[0]).toMatchObject({ project_id: "p-1", job_name: null });
    const set = (payload[0].sets as Array<Record<string, unknown>>)[0];
    expect(set).toMatchObject({ mark: "16", package_count: 3 });
    expect(set.crate).toMatchObject({ name: "Crate 1", pieces: 4, part_type: "glass" });
    expect(payload[1]).toMatchObject({ project_id: null, job_name: "Sunset Ridge 4" });
  });
});

describe("describeSet + helpers", () => {
  it("says the crate part in one line", () => {
    expect(
      describeSet({
        mark: "16",
        kind: "window",
        package_count: 3,
        crate: { name: "Crate 1", pieces: 4, part_type: "glass" },
      }),
    ).toBe("#16 · Window · 3 packages + 4 pieces of glass in Crate 1");
  });

  it("normalizeMark strips the hash and uppercases", () => {
    expect(normalizeMark(" #13a ")).toBe("13A");
  });

  it("empty scaffolds start valid enough to edit", () => {
    expect(emptyEntry().sets).toHaveLength(1);
    expect(emptySet().kind).toBe("window");
  });
});

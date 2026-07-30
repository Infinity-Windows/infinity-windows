import { describe, expect, it } from "vitest";
import {
  matchesPlanFilter,
  resolveFilter,
  visibleFilters,
  type PlanFilter,
} from "./openingFilter";
import type { ProjectOpening } from "./types";

function opening(over: Partial<ProjectOpening> = {}): ProjectOpening {
  return {
    status: "planned",
    assigned_to: null,
    window_types: { category: "Window", type_code: "SH", name: "Single Hung" },
    ...over,
  } as unknown as ProjectOpening;
}

const ME = "profile-taylor";
const AMMON = "profile-ammon";

describe("matchesPlanFilter", () => {
  it("mine keeps only the viewer's own openings", () => {
    expect(matchesPlanFilter(opening({ assigned_to: ME }), "mine", ME)).toBe(true);
    expect(matchesPlanFilter(opening({ assigned_to: AMMON }), "mine", ME)).toBe(
      false,
    );
    expect(matchesPlanFilter(opening(), "mine", ME)).toBe(false);
  });

  it("mine matches nothing when nobody is signed in", () => {
    // The dangerous bug would be the opposite: a signed-out view showing every
    // opening as "mine".
    expect(matchesPlanFilter(opening({ assigned_to: ME }), "mine", null)).toBe(
      false,
    );
    expect(
      matchesPlanFilter(opening({ assigned_to: ME }), "mine", undefined),
    ).toBe(false);
  });

  it("keeps the filters that already existed working", () => {
    const installed = opening({ status: "installed" });
    const door = opening({
      window_types: { category: "Door", type_code: "XO", name: "Patio" },
    } as Partial<ProjectOpening>);

    expect(matchesPlanFilter(installed, "open", ME)).toBe(false);
    expect(matchesPlanFilter(opening(), "open", ME)).toBe(true);
    expect(matchesPlanFilter(installed, "done", ME)).toBe(true);
    expect(matchesPlanFilter(door, "doors", ME)).toBe(true);
    expect(matchesPlanFilter(door, "windows", ME)).toBe(false);
    expect(matchesPlanFilter(opening(), "windows", ME)).toBe(true);
    expect(matchesPlanFilter(installed, "all", ME)).toBe(true);
  });
});

describe("visibleFilters", () => {
  it("hides Mine when the viewer has nothing on this job", () => {
    // Today's production state: 151 openings, one assignee company-wide.
    const ids = visibleFilters(
      [opening(), opening({ assigned_to: AMMON })],
      ME,
    ).map((f) => f.id);
    expect(ids).not.toContain("mine");
    expect(ids).toEqual(["all", "open", "windows", "doors", "done"]);
  });

  it("shows Mine once the viewer has work here", () => {
    const ids = visibleFilters(
      [opening(), opening({ assigned_to: ME })],
      ME,
    ).map((f) => f.id);
    expect(ids).toContain("mine");
    expect(ids[1]).toBe("mine");
  });

  it("hides Mine from a signed-out viewer", () => {
    expect(
      visibleFilters([opening({ assigned_to: ME })], null).map((f) => f.id),
    ).not.toContain("mine");
  });
});

describe("resolveFilter", () => {
  it("drops back to All when the active chip disappears", () => {
    // Someone on Mine gets their last opening reassigned away.
    const available = visibleFilters([opening()], ME);
    expect(resolveFilter("mine" as PlanFilter, available)).toBe("all");
  });

  it("leaves a still-available chip alone", () => {
    const available = visibleFilters([opening({ assigned_to: ME })], ME);
    expect(resolveFilter("mine", available)).toBe("mine");
    expect(resolveFilter("doors", available)).toBe("doors");
  });
});

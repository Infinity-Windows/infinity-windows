import { describe, expect, it } from "vitest";
import { building3CadDrafts } from "./cadUnitPreview";
import { matchPlanOpening } from "./matchCadPlanOpening";

const origin = { x: 0, y: 0 };
const drafts = [
  ...building3CadDrafts(1, [
    { text: "Tech Ridge Building #3 CADs-1", x: .74, y: .90 },
    { text: "A", x: .09, y: .10 },
    { text: "A (spandrel)", x: .51, y: .10 },
  ]),
  ...building3CadDrafts(8, [
    { text: "Tech Ridge Building #3 CADs-8", x: .74, y: .90 },
    { text: "A-1", x: .09, y: .10 },
  ]),
];

describe("CAD item matching", () => {
  it("uses the verified item number to disambiguate visually similar configurations", () => {
    const labels = [{ ...origin, text: "A", linework: true }];
    expect(matchPlanOpening(origin, labels, drafts, "2", true)?.draft.label).toBe("A (spandrel)");
    expect(matchPlanOpening(origin, labels, drafts, "2", false)).toBeNull();
  });

  it("leaves the base and suffixed marks open when the exact variant is unresolved", () => {
    expect(drafts[0].quantity).toBe(18);
    expect(matchPlanOpening(origin, [], drafts, "1", true)).toBeNull();
    expect(matchPlanOpening(origin, [], drafts, "1-A", true)).toBeNull();
  });
});

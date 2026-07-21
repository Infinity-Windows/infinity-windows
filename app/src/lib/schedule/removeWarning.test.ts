import { describe, expect, it } from "vitest";
import { removeWarning } from "./removeWarning";

describe("removeWarning", () => {
  it("gives a plain, permanent warning for a draft", () => {
    const w = removeWarning({ status: "draft", jobLabel: "J-100", crewCount: 2 });
    expect(w.published).toBe(false);
    expect(w.title).toBe("Remove assignment?");
    expect(w.confirmLabel).toBe("Remove");
    expect(w.lines.join(" ")).toMatch(/J-100/);
    expect(w.lines.join(" ")).toMatch(/undone/);
  });

  it("warns that the crew will be notified for a published assignment", () => {
    const w = removeWarning({ status: "published", jobLabel: "J-100", crewCount: 3 });
    expect(w.published).toBe(true);
    expect(w.title).toMatch(/published/i);
    expect(w.confirmLabel).toMatch(/notify/i);
    const body = w.lines.join(" ");
    expect(body).toMatch(/sent to the field/i);
    expect(body).toMatch(/notify all 3 crew members/i);
  });

  it("uses singular crew wording for one member", () => {
    const w = removeWarning({ status: "published", jobLabel: null, crewCount: 1 });
    expect(w.lines.join(" ")).toMatch(/the crew member on it/);
  });

  it("falls back gracefully with no job label or crew", () => {
    const w = removeWarning({ status: "published", crewCount: 0 });
    const body = w.lines.join(" ");
    expect(body).not.toMatch(/ for /);
    expect(body).toMatch(/notify the crew/);
  });
});

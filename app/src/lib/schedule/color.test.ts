import { describe, expect, it } from "vitest";
import { INSTALLER_PALETTE } from "../install/mapDispatch";
import { assignmentColor, assignmentColorKey, colorForKey } from "./color";

describe("assignmentColorKey", () => {
  it("prefers the first foreman, then any member, then the id", () => {
    expect(
      assignmentColorKey({
        id: "a",
        members: [
          { profile_id: "i1", role: "installer" },
          { profile_id: "f1", role: "foreman" },
        ],
      }),
    ).toBe("f1");
    expect(
      assignmentColorKey({ id: "a", members: [{ profile_id: "i1", role: "installer" }] }),
    ).toBe("i1");
    expect(assignmentColorKey({ id: "solo", members: [] })).toBe("solo");
  });
});

describe("colorForKey", () => {
  it("is deterministic and within the palette", () => {
    const c = colorForKey("f1");
    expect(colorForKey("f1")).toBe(c);
    expect(INSTALLER_PALETTE).toContain(c as (typeof INSTALLER_PALETTE)[number]);
  });
});

describe("assignmentColor", () => {
  it("honors an explicit color override", () => {
    expect(
      assignmentColor({ id: "a", color: "#123456", members: [{ profile_id: "f1", role: "foreman" }] }),
    ).toBe("#123456");
  });

  it("falls back to color-by-crew", () => {
    expect(
      assignmentColor({ id: "a", color: null, members: [{ profile_id: "f1", role: "foreman" }] }),
    ).toBe(colorForKey("f1"));
  });
});

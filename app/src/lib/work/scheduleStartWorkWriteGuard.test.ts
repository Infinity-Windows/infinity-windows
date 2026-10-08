import { describe, expect, it } from "vitest";
import { expectedForegroundTouch } from "../../../e2e/support/scheduleStartWorkWriteGuard";
const presenceOnly = { p_lat: null, p_lng: null, p_accuracy_m: null };
describe("Schedule open-shift fixture admits only the existing denied-GPS presence stamp", () => {
  it("admits its exact shape only in the declared open-shift scenario", () => {
    expect(expectedForegroundTouch(true, presenceOnly)).toBe(true);
    expect(expectedForegroundTouch(false, presenceOnly)).toBe(false);
  });
  it.each([null, undefined, [], "null", {}, { p_lat: null }, { ...presenceOnly, p_shift_id: "other-shift" }, { ...presenceOnly, p_project_id: "BLACK22" }, { ...presenceOnly, action: "clock_in" }].map((body) => ({ body })))("refuses malformed/incomplete/extra authority fields: %j", ({ body }) => {
    expect(expectedForegroundTouch(true, body)).toBe(false);
  });
  it.each(["p_lat", "p_lng", "p_accuracy_m"])("refuses even one actual GPS value in %s", (field) => {
    expect(expectedForegroundTouch(true, { ...presenceOnly, [field]: 1 })).toBe(false);
    expect(expectedForegroundTouch(true, { ...presenceOnly, [field]: "1" })).toBe(false);
  });
});

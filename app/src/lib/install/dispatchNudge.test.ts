import { describe, expect, it } from "vitest";
import { dispatchNudge, dispatchNudgeText } from "./dispatchNudge";

const planned = { assigned_to: null, status: "planned" };
const installed = { assigned_to: null, status: "installed" };
const lead = { isLead: true, dispatchMode: false };

describe("dispatchNudge", () => {
  it("offers dispatch on a job where nobody is assigned", () => {
    // Black Desert today: 42 openings, no assignees.
    expect(dispatchNudge([planned, planned, planned], lead)).toEqual({
      unassigned: 3,
    });
  });

  it("disappears as soon as one opening is assigned", () => {
    expect(
      dispatchNudge([planned, { assigned_to: "ammon", status: "planned" }], lead),
    ).toBeNull();
  });

  it("stays hidden from an installer", () => {
    expect(
      dispatchNudge([planned], { isLead: false, dispatchMode: false }),
    ).toBeNull();
  });

  it("stays hidden while dispatch is already open", () => {
    expect(dispatchNudge([planned], { isLead: true, dispatchMode: true })).toBeNull();
  });

  it("does not count finished work as needing an assignee", () => {
    expect(dispatchNudge([planned, installed, installed], lead)).toEqual({
      unassigned: 1,
    });
  });

  it("says nothing on a fully installed job", () => {
    expect(dispatchNudge([installed, installed], lead)).toBeNull();
  });

  it("says nothing on a job with no openings", () => {
    expect(dispatchNudge([], lead)).toBeNull();
  });
});

describe("dispatchNudgeText", () => {
  it("reads as a sentence, singular and plural", () => {
    expect(dispatchNudgeText({ unassigned: 1 })).toBe(
      "1 opening isn't assigned to anyone.",
    );
    expect(dispatchNudgeText({ unassigned: 42 })).toBe(
      "42 openings aren't assigned to anyone.",
    );
  });
});

import { describe, expect, it } from "vitest";
import { isPendingShiftId, startDayPlan, tapsToWorking, unitWorkLocked } from "./startDay";

describe("startDayPlan (K1.3)", () => {
  it("clocks straight in when today's talk is already signed", () => {
    expect(startDayPlan({ talkExists: true, signedToday: true, ruleActive: false })).toBe("clock-in");
    expect(startDayPlan({ talkExists: true, signedToday: true, ruleActive: true })).toBe("clock-in");
  });

  it("clocks straight in when there is no talk today", () => {
    expect(startDayPlan({ talkExists: false, signedToday: false, ruleActive: false })).toBe("clock-in");
  });

  it("unsigned with the rule OFF: the talk first, signing it is the clock-in (today's timing)", () => {
    expect(startDayPlan({ talkExists: true, signedToday: false, ruleActive: false })).toBe(
      "sign-then-clock-in",
    );
  });

  it("unsigned with the rule ON: paid time starts at the tap, the talk is signed on the clock", () => {
    expect(startDayPlan({ talkExists: true, signedToday: false, ruleActive: true })).toBe(
      "clock-in-then-sign",
    );
  });

  it("fails OPEN when the talk or the signature could not be read — the server is the backstop", () => {
    expect(startDayPlan({ talkExists: null, signedToday: null, ruleActive: false })).toBe("clock-in");
    expect(startDayPlan({ talkExists: true, signedToday: null, ruleActive: false })).toBe("clock-in");
    expect(startDayPlan({ talkExists: null, signedToday: false, ruleActive: true })).toBe("clock-in");
  });
});

describe("unitWorkLocked", () => {
  it("locks only on a positively known unsigned talk", () => {
    expect(unitWorkLocked({ talkExists: true, signedToday: false })).toBe(true);
    expect(unitWorkLocked({ talkExists: true, signedToday: true })).toBe(false);
    expect(unitWorkLocked({ talkExists: false, signedToday: false })).toBe(false);
    expect(unitWorkLocked({ talkExists: null, signedToday: false })).toBe(false);
    expect(unitWorkLocked({ talkExists: true, signedToday: null })).toBe(false);
  });
});

describe("tapsToWorking (the K-X3 number)", () => {
  it("is one tap when signed, two either way when not", () => {
    expect(tapsToWorking("clock-in")).toBe(1);
    expect(tapsToWorking("sign-then-clock-in")).toBe(2);
    expect(tapsToWorking("clock-in-then-sign")).toBe(2);
  });
});

describe("isPendingShiftId", () => {
  it("recognises the outbox's synthetic shift ids", () => {
    expect(isPendingShiftId("pending:abc")).toBe(true);
    expect(isPendingShiftId("55555555-eeee-4eee-8eee-555555555555")).toBe(false);
    expect(isPendingShiftId(null)).toBe(false);
  });
});

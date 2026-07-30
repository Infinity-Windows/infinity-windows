import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetAllLocalStarts,
  forgetLocalStart,
  recallLocalStart,
  rememberLocalStart,
} from "./installStart";
import { AUTO_TIMER_CAP_MINUTES } from "./installTimer";

const NOON = Date.parse("2026-07-29T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOON - minutesAgo * 60000).toISOString();

beforeEach(() => {
  forgetAllLocalStarts();
});

describe("local install starts", () => {
  it("remembers nothing until work is actually started", () => {
    expect(recallLocalStart("op-1", NOON)).toBeNull();
  });

  it("survives a reload, which is the entire point", () => {
    rememberLocalStart("op-1", at(12));
    expect(recallLocalStart("op-1", NOON)).toBe(at(12));
  });

  it("keeps each opening's start separate", () => {
    rememberLocalStart("op-1", at(12));
    rememberLocalStart("op-2", at(3));
    expect(recallLocalStart("op-1", NOON)).toBe(at(12));
    expect(recallLocalStart("op-2", NOON)).toBe(at(3));
  });

  it("does not restart the clock if they tap Start twice", () => {
    rememberLocalStart("op-1", at(12));
    rememberLocalStart("op-1", at(1));
    expect(recallLocalStart("op-1", NOON)).toBe(at(12));
  });

  it("forgets a start once the install is submitted", () => {
    rememberLocalStart("op-1", at(12));
    forgetLocalStart("op-1");
    expect(recallLocalStart("op-1", NOON)).toBeNull();
  });

  it("ignores a stale tap from days ago instead of resurrecting it", () => {
    // Someone tapped Start, walked off, and came back Monday. That is not a
    // 3,000-minute install in progress.
    rememberLocalStart("op-1", at(AUTO_TIMER_CAP_MINUTES + 1));
    expect(recallLocalStart("op-1", NOON)).toBeNull();
    // And it is cleared, so it cannot come back.
    expect(recallLocalStart("op-1", NOON)).toBeNull();
  });

  it("ignores junk without throwing", () => {
    rememberLocalStart("op-1", "not a date");
    expect(recallLocalStart("op-1", NOON)).toBeNull();
    expect(recallLocalStart("", NOON)).toBeNull();
    rememberLocalStart("", at(5));
    expect(recallLocalStart("", NOON)).toBeNull();
  });
});

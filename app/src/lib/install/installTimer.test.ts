import { describe, expect, it } from "vitest";
import {
  AUTO_TIMER_CAP_MINUTES,
  CLOCK_IN_BLOCKER,
  TOOLBOX_BLOCKER,
  canStartInstall,
  clockEligibility,
  elapsedMinutes,
  installTimer,
  isClockGateError,
  recordedMinutes,
  resolveStartedAt,
} from "./installTimer";

const NOON = Date.parse("2026-07-29T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOON - minutesAgo * 60000).toISOString();

describe("clockEligibility", () => {
  it("says nothing until both answers are back", () => {
    // The bug shipped because the screen assumed it could start. Before the
    // server has answered, the honest state is "don't know yet" — which shows
    // neither a red banner nor a running clock.
    const e = clockEligibility({ clockedIn: false, toolboxSigned: false, resolved: false });
    expect(e.status).toBe("unknown");
    expect(e.blockers).toEqual([]);
  });

  it("blocks with both reasons when neither gate is met", () => {
    const e = clockEligibility({ clockedIn: false, toolboxSigned: false, resolved: true });
    expect(e.status).toBe("blocked");
    expect(e.blockers).toEqual([CLOCK_IN_BLOCKER, TOOLBOX_BLOCKER]);
  });

  it("still blocks when clocked in but the talk isn't signed", () => {
    const e = clockEligibility({ clockedIn: true, toolboxSigned: false, resolved: true });
    expect(e.status).toBe("blocked");
    expect(e.blockers).toEqual([TOOLBOX_BLOCKER]);
  });

  it("still blocks when the talk is signed but they never clocked in", () => {
    const e = clockEligibility({ clockedIn: false, toolboxSigned: true, resolved: true });
    expect(e.status).toBe("blocked");
    expect(e.blockers).toEqual([CLOCK_IN_BLOCKER]);
  });

  it("clears only when both gates are met", () => {
    const e = clockEligibility({ clockedIn: true, toolboxSigned: true, resolved: true });
    expect(e.status).toBe("eligible");
    expect(e.blockers).toEqual([]);
  });
});

describe("elapsedMinutes", () => {
  it("is null with no start — an un-started install has no duration", () => {
    expect(elapsedMinutes(null, NOON)).toBeNull();
  });

  it("is null for an unparseable stamp rather than NaN", () => {
    expect(elapsedMinutes("not a date", NOON)).toBeNull();
  });

  it("rounds to whole minutes", () => {
    expect(elapsedMinutes(at(45), NOON)).toBe(45);
    expect(elapsedMinutes(new Date(NOON - 89_000).toISOString(), NOON)).toBe(1);
  });

  it("treats a future stamp as zero, never negative", () => {
    // Phone and server clocks disagree; that is a zero-length install.
    expect(elapsedMinutes(at(-30), NOON)).toBe(0);
  });
});

describe("installTimer — the bug Taylor reported", () => {
  it("does NOT count while reading specs when not clocked in", () => {
    // The exact screen from the report: red "Not on the clock yet" banner and
    // a live "INSTALLING / 1 min" at the same time. Nothing has been started,
    // so there is no number at all — not a zero, not a one.
    const t = installTimer({ eligibility: "blocked", startedAt: null, now: NOON });
    expect(t.status).toBe("blocked");
    expect(t.minutes).toBeNull();
  });

  it("does NOT count while reading specs even when clocked in", () => {
    // Being on the clock is not the same as installing this window. Opening
    // the sheet must never be what starts the clock.
    const t = installTimer({ eligibility: "eligible", startedAt: null, now: NOON });
    expect(t.status).toBe("idle");
    expect(t.minutes).toBeNull();
  });

  it("shows nothing at all while eligibility is still loading", () => {
    const t = installTimer({ eligibility: "unknown", startedAt: null, now: NOON });
    expect(t.status).toBe("unknown");
    expect(t.minutes).toBeNull();
  });

  it("counts once work has genuinely been started", () => {
    const t = installTimer({ eligibility: "eligible", startedAt: at(20), now: NOON });
    expect(t.status).toBe("running");
    expect(t.minutes).toBe(20);
  });
});

describe("installTimer — a started install keeps its time", () => {
  it("keeps counting across a refresh, because the start stamp outlives the page", () => {
    // Same start stamp, a later `now`: remounting the sheet cannot reset this,
    // which is what the server's work_started_at buys us.
    const before = installTimer({ eligibility: "eligible", startedAt: at(20), now: NOON });
    const afterRefresh = installTimer({
      eligibility: "eligible",
      startedAt: at(20),
      now: NOON + 5 * 60000,
    });
    expect(before.minutes).toBe(20);
    expect(afterRefresh.minutes).toBe(25);
  });

  it("does not throw away elapsed time if they clock out mid-install", () => {
    // Eligibility gates STARTING. The server only stamps a start for someone
    // on the clock, so time already accrued is real and must survive.
    const t = installTimer({ eligibility: "blocked", startedAt: at(40), now: NOON });
    expect(t.status).toBe("running");
    expect(t.minutes).toBe(40);
  });

  it("stops trusting itself once it outlasts a shift", () => {
    // A phone left in a pocket on the install screen overnight. Better to ask
    // for the real number than to write a confident lie into pay data.
    const t = installTimer({
      eligibility: "eligible",
      startedAt: at(AUTO_TIMER_CAP_MINUTES + 1),
      now: NOON,
    });
    expect(t.status).toBe("stale");
    expect(t.minutes).toBeNull();
  });

  it("still trusts a long but plausible install right up to the cap", () => {
    const t = installTimer({
      eligibility: "eligible",
      startedAt: at(AUTO_TIMER_CAP_MINUTES),
      now: NOON,
    });
    expect(t.status).toBe("running");
    expect(t.minutes).toBe(AUTO_TIMER_CAP_MINUTES);
  });
});

describe("canStartInstall", () => {
  it("only lets an eligible person start", () => {
    expect(canStartInstall("eligible")).toBe(true);
    expect(canStartInstall("blocked")).toBe(false);
    expect(canStartInstall("unknown")).toBe(false);
  });
});

describe("recordedMinutes", () => {
  const running = installTimer({ eligibility: "eligible", startedAt: at(30), now: NOON });
  const idle = installTimer({ eligibility: "eligible", startedAt: null, now: NOON });

  it("submits what was timed when nobody overrode it", () => {
    expect(recordedMinutes({ touched: false, manual: "", timer: running })).toBe(30);
  });

  it("submits nothing when nothing was timed", () => {
    // Crucially null, not 0: zero minutes would beat every par time and mint
    // an undeserved `par` point.
    expect(recordedMinutes({ touched: false, manual: "", timer: idle })).toBeNull();
  });

  it("lets the installer override the clock by hand", () => {
    expect(recordedMinutes({ touched: true, manual: "45", timer: running })).toBe(45);
  });

  it("lets a hand-typed number stand in when the timer has nothing", () => {
    expect(recordedMinutes({ touched: true, manual: "45", timer: idle })).toBe(45);
  });

  it("treats a cleared field as no answer rather than zero", () => {
    expect(recordedMinutes({ touched: true, manual: "", timer: running })).toBeNull();
    expect(recordedMinutes({ touched: true, manual: "   ", timer: running })).toBeNull();
  });

  it("refuses nonsense and negatives", () => {
    expect(recordedMinutes({ touched: true, manual: "abc", timer: running })).toBeNull();
    expect(recordedMinutes({ touched: true, manual: "-5", timer: running })).toBeNull();
  });

  it("accepts an explicit zero from a person", () => {
    expect(recordedMinutes({ touched: true, manual: "0", timer: running })).toBe(0);
  });
});

describe("isClockGateError", () => {
  it("recognises the server's gate message", () => {
    expect(
      isClockGateError(
        new Error("clock in and complete today's toolbox talk before starting a task"),
      ),
    ).toBe(true);
  });

  it("recognises a bare string too", () => {
    expect(isClockGateError("toolbox talk not signed")).toBe(true);
  });

  it("does not mistake a dead zone for a clocking problem", () => {
    // This is the difference between "go clock in" and "carry on, we'll sync".
    expect(isClockGateError(new Error("Failed to fetch"))).toBe(false);
    expect(isClockGateError(null)).toBe(false);
  });
});

describe("resolveStartedAt", () => {
  it("prefers the server's stamp", () => {
    expect(resolveStartedAt(at(10), at(60))).toBe(at(10));
  });

  it("falls back to the device's own stamp in a dead zone", () => {
    expect(resolveStartedAt(null, at(60))).toBe(at(60));
  });

  it("is null when neither exists", () => {
    expect(resolveStartedAt(null, null)).toBeNull();
    expect(resolveStartedAt(undefined, undefined)).toBeNull();
  });
});

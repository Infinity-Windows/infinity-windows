import { describe, expect, it } from "vitest";
import {
  WEDGE_IDLE,
  WEDGE_MAX_GAP_MS,
  WEDGE_MIN_LENGTH,
  wedgeStep,
  type WedgeState,
  type WedgeVerdict,
} from "./scanWedge";

/** Feed a burst of characters `gapMs` apart, then Enter. Mirrors exactly what
 * a real scanner (or a human) produces: one keydown per character. */
function feed(
  chars: string,
  gapMs: number,
  startAt = 0,
): { state: WedgeState; verdicts: WedgeVerdict[] } {
  let state: WedgeState = WEDGE_IDLE;
  const verdicts: WedgeVerdict[] = [];
  let at = startAt;
  for (const ch of chars) {
    const step = wedgeStep(state, { key: ch, at });
    state = step.state;
    verdicts.push(step.verdict);
    at += gapMs;
  }
  const enterStep = wedgeStep(state, { key: "Enter", at });
  verdicts.push(enterStep.verdict);
  return { state: enterStep.state, verdicts };
}

describe("wedgeStep: a genuine scanner burst", () => {
  it("resolves to scanned once Enter arrives with the label", () => {
    const { verdicts, state } = feed("PKG-000123", 5);
    expect(verdicts.at(-1)).toEqual({ kind: "scanned", text: "PKG-000123" });
    // Ready for the very next scan with no leftover state.
    expect(state).toEqual(WEDGE_IDLE);
  });

  it("collects while the burst is still forming", () => {
    const { verdicts } = feed("PKG-000123", 5);
    expect(verdicts.slice(0, -1)).toEqual(
      Array(10).fill({ kind: "collecting" }),
    );
  });

  it("carries the exact characters typed, in order", () => {
    const { verdicts } = feed("WOPS:CS:CTR-000007", 1);
    expect(verdicts.at(-1)).toEqual({ kind: "scanned", text: "WOPS:CS:CTR-000007" });
  });

  it("accepts a gap right up to (but not touching) the threshold", () => {
    // WEDGE_MAX_GAP_MS - 1 between every character is still one burst.
    const { verdicts } = feed("PKG-000123", WEDGE_MAX_GAP_MS - 1);
    expect(verdicts.at(-1)).toEqual({ kind: "scanned", text: "PKG-000123" });
  });
});

describe("wedgeStep: a short Enter is not a scan", () => {
  it("ignores a buffer shorter than the minimum length", () => {
    const { verdicts, state } = feed("A1", 5);
    expect(verdicts.at(-1)).toEqual({ kind: "ignored" });
    expect(state).toEqual(WEDGE_IDLE);
  });

  it("draws the line exactly at the minimum length", () => {
    const short = "A".repeat(WEDGE_MIN_LENGTH - 1);
    const exact = "A".repeat(WEDGE_MIN_LENGTH);
    expect(feed(short, 5).verdicts.at(-1)).toEqual({ kind: "ignored" });
    expect(feed(exact, 5).verdicts.at(-1)).toEqual({
      kind: "scanned",
      text: exact,
    });
  });
});

describe("wedgeStep: human typing pace never accumulates", () => {
  it("resets on a gap at or above the threshold, so Enter sees only the last char", () => {
    const { verdicts } = feed("PKGCODE", WEDGE_MAX_GAP_MS);
    expect(verdicts.at(-1)).toEqual({ kind: "ignored" });
  });

  it("a slow typist hitting Enter after a normal sentence never fires a scan", () => {
    const { verdicts } = feed("checked in ok", 120);
    expect(verdicts.at(-1)).toEqual({ kind: "ignored" });
  });

  it("one slow gap in the middle of an otherwise-fast burst breaks it in two", () => {
    // Fast up to the gap, so the buffer is long enough there to almost pass
    // — the slow gap must still throw it away rather than average out.
    let state: WedgeState = WEDGE_IDLE;
    let at = 0;
    for (const ch of "PKG-00") {
      state = wedgeStep(state, { key: ch, at }).state;
      at += 5;
    }
    // One slow gap: the buffer restarts from this character alone.
    at += WEDGE_MAX_GAP_MS;
    state = wedgeStep(state, { key: "9", at }).state;
    expect(state.buffer).toBe("9");
    const enter = wedgeStep(state, { key: "Enter", at: at + 5 });
    expect(enter.verdict).toEqual({ kind: "ignored" });
  });
});

describe("wedgeStep: non-character keys mid-burst", () => {
  it("passes a modifier key through without disturbing the buffer", () => {
    let state: WedgeState = WEDGE_IDLE;
    state = wedgeStep(state, { key: "P", at: 0 }).state;
    state = wedgeStep(state, { key: "K", at: 5 }).state;
    const shiftStep = wedgeStep(state, { key: "Shift", at: 10 });
    expect(shiftStep.state).toBe(state); // untouched, same reference
    expect(shiftStep.verdict).toEqual({ kind: "collecting" });
    state = shiftStep.state;
    state = wedgeStep(state, { key: "G", at: 12 }).state;
    expect(state.buffer).toBe("PKG");
  });

  it("reports idle for a lone modifier key with no burst forming", () => {
    const step = wedgeStep(WEDGE_IDLE, { key: "Tab", at: 0 });
    expect(step.verdict).toEqual({ kind: "idle" });
    expect(step.state).toBe(WEDGE_IDLE);
  });
});

describe("wedgeStep: back-to-back scans", () => {
  it("is ready for a second scan immediately after the first resolves", () => {
    const first = feed("PKG-000123", 5);
    expect(first.verdicts.at(-1)).toEqual({ kind: "scanned", text: "PKG-000123" });
    const second = feed("PKG-000456", 5, 10_000);
    expect(second.verdicts.at(-1)).toEqual({ kind: "scanned", text: "PKG-000456" });
  });
});

import { describe, expect, it } from "vitest";
import { revealScrollLeft, stripEdges, type StripMetrics } from "./scrollStrip";

/** A strip 390px wide (a phone) holding 674px of tabs (the project hub). */
const phone = (scrollLeft: number): StripMetrics => ({
  scrollLeft,
  scrollWidth: 674,
  clientWidth: 390,
});

describe("stripEdges", () => {
  it("says nothing is hidden when the tabs already fit", () => {
    expect(stripEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 1080 })).toBe("none");
  });

  it("ignores the sub-pixel width browsers report for a strip that fits", () => {
    expect(stripEdges({ scrollLeft: 0, scrollWidth: 390.4, clientWidth: 390 })).toBe("none");
  });

  it("points to the end when parked at the start", () => {
    expect(stripEdges(phone(0))).toBe("end");
  });

  it("points to the start when scrolled all the way right", () => {
    expect(stripEdges(phone(284))).toBe("start");
  });

  it("points both ways in the middle", () => {
    expect(stripEdges(phone(120))).toBe("both");
  });

  it("still reads as the end when the browser is a fraction short of it", () => {
    expect(stripEdges(phone(283.6))).toBe("start");
  });
});

describe("revealScrollLeft", () => {
  it("leaves a tab alone when it is already comfortably in view", () => {
    expect(revealScrollLeft({ offsetLeft: 120, offsetWidth: 90 }, phone(60))).toBeNull();
  });

  it("never scrolls a strip whose tabs all fit", () => {
    const desktop = { scrollLeft: 0, scrollWidth: 600, clientWidth: 1080 };
    expect(revealScrollLeft({ offsetLeft: 400, offsetWidth: 120 }, desktop)).toBeNull();
  });

  it("scrolls right to bring the last tab into view", () => {
    // "Brain" sits at 560..674 while the phone shows 0..390.
    expect(revealScrollLeft({ offsetLeft: 560, offsetWidth: 114 }, phone(0))).toBe(284);
  });

  it("scrolls back left to bring the first tab into view", () => {
    expect(revealScrollLeft({ offsetLeft: 4, offsetWidth: 100 }, phone(284))).toBe(0);
  });

  it("keeps a sliver of the neighbouring tab visible", () => {
    // Fully visible but flush against the right edge: pull it in by the padding.
    expect(revealScrollLeft({ offsetLeft: 300, offsetWidth: 90 }, phone(0), 24)).toBe(24);
  });

  it("clamps to the ends rather than over-scrolling", () => {
    expect(revealScrollLeft({ offsetLeft: 660, offsetWidth: 14 }, phone(0), 200)).toBe(284);
    expect(revealScrollLeft({ offsetLeft: 0, offsetWidth: 40 }, phone(100), 200)).toBe(0);
  });

  it("reports no move when the clamped target is where it already is", () => {
    expect(revealScrollLeft({ offsetLeft: 660, offsetWidth: 14 }, phone(284), 200)).toBeNull();
  });
});

// @vitest-environment happy-dom
//
// Where the newest Ask message lands (owner's note, 2026-09-24: "it should be
// the most recent thing I see"). The page measures; these are the decisions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLLOW_SLACK, REVEAL_GAP, inBand, isTextEntry, readingHistory, revealDelta, unionSpan, visibleBand } from "./askLatest";

// An iPhone-sized band: under the sticky sync strip, above the tab bar.
const band = { top: 60, bottom: 740 };

describe("revealDelta", () => {
  it("leaves a message that is already on screen where it is", () => {
    expect(revealDelta({ top: 200, bottom: 320 }, band)).toBe(0);
  });

  it("brings a message above the screen down to the top of it, with the cards still under it", () => {
    // The person is down at the daily log card; the reply landed in the thread above.
    expect(revealDelta({ top: -900, bottom: -780 }, band)).toBe(-960);
  });

  it("brings a message below the screen up to just above the tab bar", () => {
    expect(revealDelta({ top: 900, bottom: 1000 }, band)).toBe(260);
  });

  it("shows the START of a reply taller than the screen, wherever it is", () => {
    expect(revealDelta({ top: 900, bottom: 2400 }, band)).toBe(840);
    expect(revealDelta({ top: -1500, bottom: 300 }, band)).toBe(-1560);
  });
});

describe("readingHistory", () => {
  it("someone at the end of the thread, or below it at the cards, is following along", () => {
    expect(readingHistory({ top: 300, bottom: 400 }, band)).toBe(false);
    expect(readingHistory({ top: -600, bottom: -500 }, band)).toBe(false);
  });

  it("the end of a message just under the tab bar still counts as the end", () => {
    expect(readingHistory({ top: 600, bottom: band.bottom + FOLLOW_SLACK }, band)).toBe(false);
  });

  it("someone who scrolled up, leaving the newest message below the screen, is reading", () => {
    expect(readingHistory({ top: 1200, bottom: 1300 }, band)).toBe(true);
  });

  it("nothing to compare against is not reading", () => {
    expect(readingHistory(null, band)).toBe(false);
  });
});

describe("inBand and unionSpan", () => {
  it("any part on screen counts as on screen", () => {
    expect(inBand({ top: 700, bottom: 900 }, band)).toBe(true);
    expect(inBand({ top: 760, bottom: 900 }, band)).toBe(false);
  });

  it("joins the newest message and the wait bubble, skipping what is not there", () => {
    expect(unionSpan([{ top: 100, bottom: 160 }, null, { top: 170, bottom: 210 }])).toEqual({ top: 100, bottom: 210 });
    expect(unionSpan([null, { top: 5, bottom: 5 }])).toBeNull();
  });
});

describe("visibleBand", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
  const place = (className: string, top: number, bottom: number) => {
    const el = document.createElement("div");
    el.className = className;
    el.getBoundingClientRect = () => ({ top, bottom, height: bottom - top, left: 0, right: 375, width: 375, x: 0, y: top, toJSON: () => ({}) });
    document.body.appendChild(el);
    return el;
  };

  it("is the screen less the stuck sync strip, the tab bar and the pinned recorder", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(812);
    place("sync-strip", 0, 47);
    place("tabbar", 764, 812);
    const dock = place("ask-dock", 640, 756);
    expect(visibleBand(null)).toEqual({ top: 47 + REVEAL_GAP, bottom: 764 - REVEAL_GAP });
    expect(visibleBand(dock)).toEqual({ top: 47 + REVEAL_GAP, bottom: 640 - REVEAL_GAP });
  });

  it("a sync strip still in its place further down the page covers nothing", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(812);
    place("sync-strip", 120, 160);
    expect(visibleBand(null)).toEqual({ top: REVEAL_GAP, bottom: 812 - REVEAL_GAP });
  });
});

describe("isTextEntry", () => {
  it("is true only for fields that raise a keyboard", () => {
    const text = document.createElement("input");
    const box = document.createElement("input"); box.type = "checkbox";
    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(document.createElement("textarea"))).toBe(true);
    expect(isTextEntry(box)).toBe(false);
    expect(isTextEntry(document.createElement("button"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

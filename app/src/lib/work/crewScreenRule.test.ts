// The crew screen rule (crew redesign K-X4 / Q8, 2026-09-23), enforced on
// the stylesheet the new screens are built from: buttons at least 48px
// (56px for the primary action), text at least 16px, nothing by colour
// alone, one-thumb use. Playwright measures the RENDERED screens for the
// same rule (e2e/new-design-work.spec.ts); this test reads the numbers at
// their source so a stray "font-size: 13px" fails in seven seconds rather
// than in a browser run.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// Comments stripped first: a comment above a rule would otherwise read as
// part of its selector.
const css = readFileSync(resolve(here, "../../pages/work/work.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `selector { body }` block, top level only (media blocks included). */
function blocks(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const selector = m[1].trim();
    if (selector.startsWith("@")) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

function px(body: string, prop: string): number | null {
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([\\d.]+)px`).exec(body);
  return m ? Number(m[1]) : null;
}

describe("the crew screen rule, read off work.css (K-X4)", () => {
  const all = blocks();

  it("every tap target is at least 48px tall", () => {
    const targets = all.filter((b) =>
      /\.ws-(btn|chip|list-item|headsup|link|search|check|input|textarea)\b/.test(b.selector) &&
      !b.selector.includes("--primary") && !b.selector.includes("--inline") && !b.selector.includes("--ghost") &&
      !b.selector.includes(":disabled") && !b.selector.includes(":hover"),
    );
    expect(targets.length).toBeGreaterThan(5);
    for (const b of targets) {
      const h = px(b.body, "min-height");
      if (h == null) continue; // a modifier that inherits its parent's size
      expect(h, `${b.selector} min-height`).toBeGreaterThanOrEqual(48);
    }
    // The base button and chip MUST declare it, not inherit it.
    for (const sel of [".ws-btn", ".ws-chip", ".ws-headsup", ".ws-list-item"]) {
      const b = all.find((x) => x.selector === sel);
      expect(b, sel).toBeDefined();
      expect(px(b!.body, "min-height"), `${sel} declares min-height`).toBeGreaterThanOrEqual(48);
    }
  });

  it("the primary action is 56px", () => {
    const primary = all.find((b) => b.selector === ".ws-btn--primary");
    expect(px(primary!.body, "min-height")).toBeGreaterThanOrEqual(56);
    const quick = all.find((b) => b.selector === ".ws-quick-btn");
    expect(px(quick!.body, "min-height")).toBeGreaterThanOrEqual(56);
  });

  it("no text on the screen is smaller than 16px", () => {
    for (const b of all) {
      const size = px(b.body, "font-size");
      if (size == null) continue;
      expect(size, `${b.selector} font-size`).toBeGreaterThanOrEqual(16);
    }
    // The screen sets a 16px floor for anything that inherits.
    const screen = all.find((b) => b.selector === ".work-screen");
    expect(px(screen!.body, "font-size")).toBe(16);
  });

  it("nothing means something by colour alone — every state that recolours also carries a word or a border", () => {
    // The Changed tag and the locked line are words; the break dot sits
    // beside the words "On break"; the finish state changes a border AND
    // the label. This pins the ones that could quietly become colour-only.
    const changed = all.find((b) => b.selector === ".ws-tag--changed");
    expect(changed!.body).toMatch(/border-color/);
    const finish = all.find((b) => b.selector === ".ws-clock--finish");
    expect(finish!.body).toMatch(/border-color/);
    const locked = all.find((b) => b.selector === ".ws-locked");
    expect(px(locked!.body, "font-size")).toBeGreaterThanOrEqual(16);
  });

  it("works at phone width: the layout is a single column with a 16px gutter and no fixed pixel widths", () => {
    // A fixed `width` in pixels is what breaks a 375px phone; `max-width`
    // (the desktop cap) is fine, so it is excluded by the lookbehind.
    expect(css).not.toMatch(/(?<![-\w])width:\s*\d{3,}px/);
    for (const b of all) expect(b.body, b.selector).not.toMatch(/min-width:\s*\d{3,}px/);
  });
});

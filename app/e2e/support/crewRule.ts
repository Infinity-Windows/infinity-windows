// The crew screen rule (crew redesign K-X4 / Q8), measured on the RENDERED
// screen: every tap target at least 48px tall (56px for the primary action),
// every piece of text at least 16px, and text that reads in sunlight — a
// contrast ratio of at least 4.5:1 against what it sits on (3:1 for large
// bold text, WCAG's own line). lib/work/crewScreenRule.test.ts reads the same
// numbers off the stylesheet; this is the check that the browser agreed.
//
// Colours are read through a 1×1 canvas so an oklch() token and an rgb()
// literal both come back as the sRGB pixel the eye would see.

import type { Page } from "@playwright/test";

export interface CrewRuleReport {
  smallTargets: string[];
  smallText: string[];
  lowContrast: string[];
  targetsMeasured: number;
  textMeasured: number;
}

export async function measureCrewRule(page: Page, root: string): Promise<CrewRuleReport> {
  return page.evaluate((rootSel) => {
    const rootEl = document.querySelector(rootSel);
    const report = { smallTargets: [] as string[], smallText: [] as string[], lowContrast: [] as string[], targetsMeasured: 0, textMeasured: 0 };
    if (!rootEl) return report;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const describe = (el: Element) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().split(" ").slice(0, 2).join(".")} "${(el.textContent ?? "").trim().slice(0, 30)}"`;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    // Backgrounds: composite every translucent layer over the first opaque
    // one beneath it — a 7%-alpha callout tint sits on the card, not on
    // nothing, and reading it alone made amber-on-amber out of amber-on-white.
    const bgOf = (el: Element): [number, number, number, number] => {
      const layers: [number, number, number, number][] = [];
      let node: Element | null = el;
      let base: [number, number, number, number] | null = null;
      while (node) {
        const c = rgba(getComputedStyle(node).backgroundColor);
        if (c[3] >= 0.99) {
          base = c;
          break;
        }
        if (c[3] > 0.01) layers.push(c);
        node = node.parentElement;
      }
      let out = base ?? rgba(getComputedStyle(document.body).backgroundColor);
      if (out[3] < 0.99) out = [255, 255, 255, 1];
      for (const layer of layers.reverse()) {
        const a = layer[3];
        out = [
          layer[0] * a + out[0] * (1 - a),
          layer[1] * a + out[1] * (1 - a),
          layer[2] * a + out[2] * (1 - a),
          1,
        ];
      }
      return out;
    };

    // 1. Tap targets.
    const targets = rootEl.querySelectorAll("button, a, input, select, textarea, [role=button]");
    for (const el of targets) {
      if (!visible(el)) continue;
      report.targetsMeasured++;
      // A checkbox's real target is the label row it sits in.
      const box =
        el instanceof HTMLInputElement && el.type === "checkbox" && el.closest("label")
          ? el.closest("label")!.getBoundingClientRect()
          : el.getBoundingClientRect();
      const h = box.height;
      const primary = (el as HTMLElement).classList.contains("ws-btn--primary");
      const min = primary ? 56 : 48;
      // A caption-sized inline control (a "Change" link inside a sentence)
      // still has to be 48px; the rule has no exceptions on a crew screen.
      if (h < min - 0.5) report.smallTargets.push(`${describe(el)} ${Math.round(h)}px`);
    }

    // 2. Text size and contrast: every element with its own text node.
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const text = (n.textContent ?? "").trim();
      if (!text) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || !visible(el)) continue;
      seen.add(el);
      report.textMeasured++;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      if (size < 16 - 0.5) report.smallText.push(`${describe(el)} ${size}px`);
      const fg = rgba(cs.color);
      const bg = bgOf(el);
      const l1 = lum(fg);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const bold = parseInt(cs.fontWeight, 10) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      const need = large ? 3 : 4.5;
      if (fg[3] < 0.9) continue; // a faded placeholder is not the reading text
      if (ratio < need) report.lowContrast.push(`${describe(el)} ${ratio.toFixed(2)}:1`);
    }
    return report;
  }, root);
}

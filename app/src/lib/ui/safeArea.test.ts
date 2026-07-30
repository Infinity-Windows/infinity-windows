import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Installed to an iPhone home screen, this app draws edge to edge: index.html
 * asks for `viewport-fit=cover` and a translucent status bar, so the page runs
 * under the clock, the battery and the home indicator instead of starting below
 * them. Anything pinned to an edge has to move itself out of the way, and the
 * close buttons on the full-screen plan editors did not — they came out under
 * the status bar, which is what Taylor reported.
 *
 * This has to be a source test. No headless browser reports a non-zero
 * `env(safe-area-inset-*)`: Chrome, Playwright and jsdom all answer 0px, so a
 * rendering test of this bug passes on a layout that is broken on the phone. The
 * only honest thing a machine in this repo can check is the stylesheet itself —
 * that every overlay which can reach an edge of the screen is accounted for, and
 * that none of them went back to hard-coding the inset.
 *
 * The real device check is a human with an iPhone; see the PR.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const css = read("src/index.css");

interface Rule {
  selectors: string[];
  body: string;
  line: number;
}

/**
 * Every `selector { declarations }` in the file, including the ones nested in a
 * media query — the inner braces match on their own, which is all this needs.
 *
 * The text before a `{` runs back to the end of the last rule, so it can carry
 * an `@import ...;` or a stray statement with it; only what follows the last
 * semicolon is the selector.
 */
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].split(";").pop()!.trim();
    // A media query's own head is followed by a nested block, never by
    // declarations, so anything starting with @ is not a rule.
    if (head.startsWith("@") || head === "") continue;
    out.push({
      selectors: head
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      body: m[2],
      line: source.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** Comments are prose, and prose contains commas and semicolons. Blanked
 *  rather than removed so the line numbers in a failure still point at the
 *  stylesheet. */
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
const all = rules(withoutComments);
const declares = (body: string, prop: string) =>
  new RegExp(`(?:^|[;{\\s])${prop}\\s*:`).test(body);

/**
 * Backdrops. A scrim is a flat sheet of colour with nothing in it to tap, so it
 * is *supposed* to cover the status bar — dimming the whole screen is the point.
 * What it holds is a separate element with its own rule, and that element is
 * what the height caps below are for.
 */
const SCRIMS = new Set([
  ".menu-drawer-backdrop",
  ".capture-backdrop",
  ".clock-sheet-backdrop",
  ".maps-backdrop",
  ".modal-backdrop",
  ".more-sheet-backdrop",
  ".pin-modal-backdrop",
  ".sched-sheet-backdrop",
  ".travel-sheet-backdrop",
  ".wizard-backdrop",
]);

/** Which token a given overlay is meant to get its ceiling from. */
const SHEET_CAPS: Record<string, string> = {
  // Sit on the bottom of the screen.
  ".clock-sheet": "--sheet-max-h",
  ".sched-sheet": "--sheet-max-h",
  ".travel-sheet": "--sheet-max-h",
  ".maps-sheet": "--sheet-max-h",
  // Sit on top of the bottom bar, so they start higher and may grow less.
  ".capture-sheet": "--sheet-max-h-above-tabbar",
  ".jobphoto-sheet": "--sheet-max-h-above-tabbar",
  ".menu-drawer": "--sheet-max-h-above-tabbar",
  // Centred, so half of any height they gain goes upward.
  ".wizard-card": "--dialog-max-h",
  ".modal-card": "--dialog-max-h",
  ".pin-modal-card": "--dialog-max-h",
};

/** Every rule body that mentions the class, joined — a class may be styled in
 *  several places, and only the union of them has to be right. */
function bodiesFor(selector: string): string {
  return all
    .filter((r) => r.selectors.some((s) => s === selector || s.startsWith(`${selector}:`)))
    .map((r) => r.body)
    .join("\n");
}

describe("safe-area tokens are the only way to read an inset", () => {
  it("nothing outside :root calls env(safe-area-inset-*)", () => {
    const offenders = all
      .filter((r) => !r.selectors.includes(":root"))
      .filter((r) => /env\(safe-area-inset-/.test(r.body))
      .flatMap((r) => r.selectors);
    expect(offenders).toEqual([]);
  });

  it(":root defines all four", () => {
    const rootBody = bodiesFor(":root");
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(rootBody).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px)`);
    }
  });
});

describe("every overlay that can reach an edge of the screen is accounted for", () => {
  /** Fixed and positioned against the top of the screen in any way. */
  const topReaching = all.filter(
    (r) =>
      /position:\s*fixed/.test(r.body) &&
      (declares(r.body, "top") || declares(r.body, "inset")),
  );

  /** Fixed and positioned against the bottom of the screen in any way. */
  const bottomReaching = all.filter(
    (r) =>
      /position:\s*fixed/.test(r.body) &&
      (declares(r.body, "bottom") || declares(r.body, "inset")),
  );

  it("finds the overlays at all (guards the parser, not the CSS)", () => {
    expect(topReaching.length).toBeGreaterThan(8);
    expect(bottomReaching.length).toBeGreaterThan(8);
  });

  it("none of them can put a control under the status bar", () => {
    const unhandled: string[] = [];
    for (const rule of topReaching) {
      for (const selector of rule.selectors) {
        if (SCRIMS.has(selector)) continue;
        const body = bodiesFor(selector);
        const handled =
          /var\(--safe-top\)/.test(body) ||
          /var\(--sheet-max-h(-above-tabbar)?\)/.test(body) ||
          /var\(--dialog-max-h\)/.test(body);
        if (!handled) unhandled.push(`${selector} (line ${rule.line})`);
      }
    }
    // A new overlay lands here the moment it is written. Give it a height cap
    // or top padding from the tokens in :root, or — if it is only a scrim —
    // add it to SCRIMS above and say why.
    expect(unhandled).toEqual([]);
  });

  it("none of them can put a control under the home indicator", () => {
    const unhandled: string[] = [];
    for (const rule of bottomReaching) {
      for (const selector of rule.selectors) {
        if (SCRIMS.has(selector)) continue;
        const body = bodiesFor(selector);
        const handled =
          /var\(--safe-bottom\)/.test(body) || /var\(--above-tabbar\)/.test(body);
        if (!handled) unhandled.push(`${selector} (line ${rule.line})`);
      }
    }
    expect(unhandled).toEqual([]);
  });
});

describe("sheets get their ceiling from the shared token, not a magic number", () => {
  for (const [selector, token] of Object.entries(SHEET_CAPS)) {
    it(`${selector} is capped by ${token}`, () => {
      const body = bodiesFor(selector);
      expect(body).not.toBe("");
      expect(body).toMatch(new RegExp(`max-height:[^;]*var\\(${token}\\)`));
      // The old hand-rolled caps (92vh, 84dvh, calc(100vh - 48px)) are what let
      // a sheet slide up behind the clock in the first place.
      expect(body).not.toMatch(/max-height:\s*\d/);
    });
  }
});

describe("the full-screen editors keep their controls off the status bar", () => {
  for (const selector of [".plan-sheet--fullscreen", ".plan-model-editor--fullscreen"]) {
    it(`${selector} pads itself past all four insets`, () => {
      const body = bodiesFor(selector);
      expect(body).toMatch(/padding-top:\s*calc\(var\(--overlay-gap\) \+ var\(--safe-top\)\)/);
      expect(body).toMatch(/padding-bottom:\s*calc\(var\(--overlay-gap\) \+ var\(--safe-bottom\)\)/);
      expect(body).toMatch(/padding-left:\s*max\(var\(--overlay-gap\), var\(--safe-left\)\)/);
      expect(body).toMatch(/padding-right:\s*max\(var\(--overlay-gap\), var\(--safe-right\)\)/);
    });
  }

  it("the plan toolbar sticks below the status bar, not to the top of the screen", () => {
    // `padding-top` on the scroll container does not hold a sticky child back:
    // it sticks to the top of the scrollport, padding and all.
    expect(bodiesFor(".plan-fullscreen-bar")).toMatch(/top:\s*var\(--safe-top\)/);
  });
});

describe("close buttons stay big enough for a gloved thumb", () => {
  for (const selector of [
    ".menu-drawer-close",
    ".capture-close",
    ".clock-sheet-x",
    ".feature-tip-x",
    // "Exit full screen" is how you get out of the plan editor, so it is a close
    // button in everything but name.
    ".plan-fullscreen-toggle",
    ".sched-sheet-close",
    ".wizard-close",
  ]) {
    it(`${selector} is at least 44px both ways`, () => {
      const body = bodiesFor(selector);
      expect(body).toMatch(/min-width:\s*44px|width:\s*44px/);
      expect(body).toMatch(/min-height:\s*44px|height:\s*44px/);
    });
  }

  it("the plan editor's close is 44px tall", () => {
    // Wide already, because it is labelled "✕ Close" rather than being an icon.
    expect(bodiesFor(".plan-fullscreen-close")).toMatch(/min-height:\s*44px/);
  });
});

describe("the overlays named here are the ones the app actually renders", () => {
  const components = [
    "src/components/Layout.tsx",
    "src/components/clock/ClockSheet.tsx",
    "src/components/nav/AppMenuDrawer.tsx",
    "src/components/nav/CaptureSheet.tsx",
    "src/components/PhotoCaptureSheet.tsx",
    "src/components/maps/MapsChooserSheet.tsx",
    "src/components/permissions/OnboardingWizard.tsx",
    "src/components/schedule/AssignmentEditor.tsx",
    "src/components/travel/Sheet.tsx",
    "src/pages/install/PlanModelEditor.tsx",
    "src/pages/install/ProjectMap.tsx",
  ].map(read).join("\n");

  // A sheet that is renamed or deleted would otherwise leave a rule in
  // SHEET_CAPS that passes forever while guarding nothing.
  for (const selector of Object.keys(SHEET_CAPS)) {
    const className = selector.slice(1);
    if (className === "modal-card" || className === "pin-modal-card") continue;
    it(`${className} is still a class some component puts on the page`, () => {
      expect(components).toContain(className);
    });
  }
});

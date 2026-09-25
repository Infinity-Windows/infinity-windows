// K0.7.3: Work, Schedule and the clock must always open from the phone's
// cache — none of the three may depend on a network fetch once the app is
// installed.
//
// This reads SOURCE TEXT rather than rendering the app, on purpose. "Does this
// component's code ship in the entry chunk" is a fact about which `import`
// App.tsx uses (eager vs. lazyRoute), not about runtime behavior a render
// could observe — the whole point of route-level code splitting is that an
// eagerly-imported and a lazily-imported component render identically. A
// structural regression here (someone "cleaning up" MyWork/Home/Heartbeat or
// the clock sheet into a lazyRoute() to shave a few kB off the entry budget)
// would silently break the offline promise without any test that renders
// something ever noticing, since the fixture harness always has the chunk
// available locally. Literal, not a generic regex, so a future reformat of
// these exact lines is a visible, deliberate edit to this test rather than a
// pattern that quietly stops matching.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSrc = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const clockCtxSrc = readFileSync(new URL("./lib/clockContext.tsx", import.meta.url), "utf8");
const viteConfigSrc = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

describe("Work, Schedule and the clock survive a cached phone (K0.7.3)", () => {
  it("My Work, Home and Heartbeat — the three landings '/' can resolve to — ship in the entry chunk", () => {
    for (const [name, file] of [
      ["MyWork", "./pages/MyWork"],
      ["Home", "./pages/Home"],
      ["Heartbeat", "./pages/Heartbeat"],
    ] as const) {
      expect(appSrc).toContain(`import { ${name} } from "${file}";`);
      // Not the lazyRoute() route-splitting path used for everything else.
      expect(appSrc).not.toContain(`lazyRoute(() => import("${file}")`);
    }
  });

  it("the clock sheet ships in the entry chunk, not behind lazyRoute()", () => {
    expect(clockCtxSrc).toContain(
      `import { ClockSheet } from "../components/clock/ClockSheet";`,
    );
    expect(appSrc).not.toMatch(/lazyRoute\([^)]*ClockSheet/);
  });

  it("Schedule is code-split, but the service worker still precaches its chunk", () => {
    // My Schedule stays behind lazyRoute() — it doesn't need to be in the
    // entry chunk, only in the SW's precache, which is a different promise.
    expect(appSrc).toContain(
      `const MySchedule = lazyRoute(() => import("./pages/MySchedule")`,
    );
    // The workbox glob that precaches every built .js chunk (App.tsx's own
    // comment explains why offline use survives route-level code splitting).
    expect(viteConfigSrc).toMatch(/globPatterns:\s*\[\s*['"]\*\*\/\*\.\{[^}]*\bjs\b[^}]*\}['"]/);
    // Nothing excludes an ordinary page chunk from that precache — only the
    // three deliberate, named exceptions vite.config.ts documents.
    const ignoresStart = viteConfigSrc.indexOf("globIgnores:");
    expect(ignoresStart).toBeGreaterThan(-1);
    const ignoresBlock = viteConfigSrc.slice(ignoresStart, viteConfigSrc.indexOf("],", ignoresStart));
    for (const allowedException of [
      "node_modules/**/*",
      "404.html",
      "manifest.webmanifest",
      "monitoring",
    ]) {
      expect(ignoresBlock).toContain(allowedException);
    }
    // A bare wildcard here would swallow ordinary page chunks (MySchedule's
    // included) right along with the three exceptions above.
    expect(ignoresBlock).not.toMatch(/['"]assets\/\*['"]/);
    expect(ignoresBlock).not.toMatch(/['"]\*\*\/\*\.js['"]/);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The door, not the sign on the door.
 *
 * `minRole` in the NAV registry drives which tabs a role sees and what the
 * access doc says. It does NOT gate the route on its own: every route in
 * App.tsx has to opt in by wrapping itself in <RequireRole>. Nothing else in
 * the suite can see that wrapper, so a route could be marked foreman-only in
 * the registry, pass nav.test.ts, appGuide.test.ts and roleAccessDoc.test.ts,
 * and still open for anybody who types the address.
 *
 * That is exactly the state /storage was in (warehouse ticket D6): listed as
 * installer-reachable, wrapped in nothing at all. This test reads App.tsx as
 * text — the routes are a flat list of JSX, and there is no way to observe a
 * wrapper from the registry side — and checks each route we care about.
 */

const APP_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "./App.tsx");

/** Every `<Route …>` in App.tsx, as {path, source-of-that-one-route}. */
function routeBlocks(): {
  blocks: Map<string, string>;
  tagCount: number;
  pathless: number;
} {
  const src = readFileSync(APP_PATH, "utf8");
  const routesOnly = src.slice(src.indexOf("<Routes>"), src.indexOf("</Routes>"));
  const blocks = new Map<string, string>();
  // The routes are a flat list — no <Route> ever nests inside another one's
  // element prop — so splitting on the tag gives one chunk per route. Split on
  // the tag plus ANY whitespace: routes are written both on one line and
  // wrapped across several, and a splitter that only knew about the one-line
  // form silently skipped the wrapped ones (which are exactly the guarded
  // ones — the failure mode would have been a green test over an open door).
  const chunks = routesOnly.split(/<Route\s/).slice(1);
  let pathless = 0;
  for (const chunk of chunks) {
    const path = /path="([^"]*)"/.exec(chunk)?.[1];
    if (path != null) blocks.set(path, chunk);
    else pathless++;
  }
  return { blocks, tagCount: chunks.length, pathless };
}

describe("App.tsx route guards", () => {
  const { blocks, tagCount, pathless } = routeBlocks();

  it("parses every route in the file (a broken parse must not pass)", () => {
    // If the parser drops routes, every "is it guarded" check below reads
    // undefined and could look fine. Anchor it: every tag is accounted for,
    // and no two routes share a path (a duplicate would hide one of them).
    expect(tagCount).toBeGreaterThan(30);
    // The one path-less route is the <Route element={<Layout />}> the whole
    // app hangs under.
    expect(pathless).toBe(1);
    expect(blocks.size).toBe(tagCount - pathless);
  });

  it("finds the storage routes at all (guards nothing if the parse breaks)", () => {
    for (const p of ["/storage", "/storage/c/:id", "/storage/tag", "/storage/out"]) {
      expect(blocks.has(p), `no <Route path="${p}"> found in App.tsx`).toBe(true);
    }
  });

  it("gates the storage hub itself (D6)", () => {
    expect(blocks.get("/storage")).toContain("RequireRole");
  });

  it("leaves the truck-side flows open — installers tag and check out (D6)", () => {
    // Deliberate: raising these would take the job off the installers who
    // actually do it. If a later change gates them, that is a regression.
    expect(blocks.get("/storage/tag")).not.toContain("RequireRole");
    expect(blocks.get("/storage/out")).not.toContain("RequireRole");
    expect(blocks.get("/storage/arrive")).not.toContain("RequireRole");
  });

  it("leaves ONE container's page open — it is the end of 'where is it'", () => {
    // Tempting to raise this with the hub, and wrong. The Find bar on the
    // warehouse page (installer-reachable) hands out an "Open Conex 7" button
    // straight to this route, and store_packages / move_container only ask
    // that you are signed in — checking a package in is crew work by design.
    // The lead-only actions on the page (Edit, Archive) are gated inside it.
    // Gating the route would dead-end the installer's core loop.
    expect(blocks.get("/storage/c/:id")).not.toContain("RequireRole");
  });
});

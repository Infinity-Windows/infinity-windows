import { describe, expect, it } from "vitest";
import {
  buildWebManifest,
  normalizeBase,
  renderWebManifest,
  resolveNotificationUrl,
  routerBasename,
  withBase,
} from "./basePaths";

// The two bases that actually exist: the GitHub Pages subpath and local dev.
const PAGES = "/infinity-windows/";
const LOCAL = "/";

describe("normalizeBase", () => {
  it("leaves a well-formed base alone", () => {
    expect(normalizeBase(PAGES)).toBe(PAGES);
    expect(normalizeBase(LOCAL)).toBe(LOCAL);
  });

  it("reads an empty or missing base as the root", () => {
    expect(normalizeBase("")).toBe("/");
    expect(normalizeBase(undefined)).toBe("/");
    expect(normalizeBase(null)).toBe("/");
  });

  it("repairs a base written without its slashes", () => {
    expect(normalizeBase("infinity-windows")).toBe(PAGES);
    expect(normalizeBase("/infinity-windows")).toBe(PAGES);
    expect(normalizeBase("infinity-windows/")).toBe(PAGES);
  });
});

describe("withBase", () => {
  it("puts an asset under the subpath", () => {
    expect(withBase(PAGES, "icon-192.png")).toBe("/infinity-windows/icon-192.png");
    expect(withBase(PAGES, "/icon-192.png")).toBe("/infinity-windows/icon-192.png");
  });

  it("leaves local dev at the root", () => {
    expect(withBase(LOCAL, "/icon-192.png")).toBe("/icon-192.png");
  });

  it("an empty path is the base itself", () => {
    expect(withBase(PAGES, "")).toBe(PAGES);
    expect(withBase(LOCAL, "")).toBe("/");
  });

  it("never doubles a slash", () => {
    expect(withBase(PAGES, "//icon-192.png")).toBe("/infinity-windows/icon-192.png");
  });
});

describe("routerBasename", () => {
  it("drops the trailing slash React Router does not want", () => {
    expect(routerBasename(PAGES)).toBe("/infinity-windows");
  });

  it("is the root when there is no subpath", () => {
    expect(routerBasename(LOCAL)).toBe("/");
    expect(routerBasename(undefined)).toBe("/");
    expect(routerBasename("")).toBe("/");
  });

  it("lets a deep link resolve to the route the user asked for", () => {
    // What Pages hands the SPA via 404.html, and what must be left over once
    // the basename is stripped — anything else hits the catch-all and the
    // invite/deep link silently lands on Home instead.
    const requested = "/infinity-windows/crew";
    expect(requested.slice(routerBasename(PAGES).length)).toBe("/crew");
  });
});

describe("buildWebManifest", () => {
  it("opens the installed app inside the subpath, not at the domain root", () => {
    // The whole bug: start_url "/" on Pages is GitHub's 404 page.
    expect(buildWebManifest(PAGES).start_url).toBe(PAGES);
    expect(buildWebManifest(PAGES).scope).toBe(PAGES);
  });

  it("points icons at files that exist under the subpath", () => {
    expect(buildWebManifest(PAGES).icons.map((i) => i.src)).toEqual([
      "/infinity-windows/icon-192.png",
      "/infinity-windows/icon-512.png",
    ]);
  });

  it("still works at the root for local dev", () => {
    const m = buildWebManifest(LOCAL);
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.icons.map((i) => i.src)).toEqual(["/icon-192.png", "/icon-512.png"]);
  });

  it("keeps the identity the installed app is known by", () => {
    const m = buildWebManifest(PAGES);
    expect(m.name).toBe("Infinity Windows & Doors");
    expect(m.short_name).toBe("Infinity");
    expect(m.display).toBe("standalone");
    expect(m.background_color).toBe("#0C0B0A");
    expect(m.theme_color).toBe("#0C0B0A");
  });

  it("has no root-absolute path left anywhere under a subpath", () => {
    const json = renderWebManifest(PAGES);
    for (const url of [
      buildWebManifest(PAGES).start_url,
      buildWebManifest(PAGES).scope,
      ...buildWebManifest(PAGES).icons.map((i) => i.src),
    ]) {
      expect(url.startsWith(PAGES)).toBe(true);
    }
    expect(json).not.toMatch(/"\/(icon|manifest)/);
  });
});

describe("renderWebManifest", () => {
  it("is parseable JSON matching the built object", () => {
    expect(JSON.parse(renderWebManifest(PAGES))).toEqual(buildWebManifest(PAGES));
  });
});

describe("resolveNotificationUrl", () => {
  const scope = `https://infinity-windows.github.io${PAGES}`;
  const localScope = "http://localhost:5173/";

  it("sends an app path into the subpath, not the domain root", () => {
    expect(resolveNotificationUrl("/clock", scope)).toBe(
      "https://infinity-windows.github.io/infinity-windows/clock",
    );
    expect(resolveNotificationUrl("/safety", scope)).toBe(
      "https://infinity-windows.github.io/infinity-windows/safety",
    );
  });

  it("keeps the query string on a deep link", () => {
    expect(resolveNotificationUrl("/projects/abc?tab=chat", scope)).toBe(
      "https://infinity-windows.github.io/infinity-windows/projects/abc?tab=chat",
    );
  });

  it("falls back to the app itself when no url was given", () => {
    expect(resolveNotificationUrl(undefined, scope)).toBe(scope);
    expect(resolveNotificationUrl("", scope)).toBe(scope);
  });

  it("passes through a url that is already absolute", () => {
    const full = "https://infinity-windows.github.io/infinity-windows/travel/7";
    expect(resolveNotificationUrl(full, scope)).toBe(full);
  });

  it("does not prefix a path that is already inside the scope", () => {
    expect(resolveNotificationUrl("/infinity-windows/crew", scope)).toBe(
      "https://infinity-windows.github.io/infinity-windows/crew",
    );
  });

  it("behaves at the root, where there is nothing to add", () => {
    expect(resolveNotificationUrl("/clock", localScope)).toBe(
      "http://localhost:5173/clock",
    );
  });

  it("keeps the raw url rather than losing the click on a junk scope", () => {
    expect(resolveNotificationUrl("/clock", "not-a-url")).toBe("/clock");
  });
});

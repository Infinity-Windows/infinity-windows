// The GC link's token, at the two places the browser touches it (Wave H, H2).
//
// Both of these are read at STARTUP, before the router and before the session,
// so a wrong answer here is a general contractor looking at a sign-in screen or
// a 404 instead of the six questions — with nobody on our side finding out
// until he says the link is broken.
//
// The shape rule is the twin of supabase/functions/_shared/gcToken.ts's, which
// is what the edge function checks before it spends a hash. Keep them the same
// rule: this file is the reminder.

import { describe, expect, it } from "vitest";
import { gcLinkUrl, gcTokenFromPath, looksLikeGcToken } from "./gcToken";

/** What create_gc_link actually produces: base64url of 32 bytes, unpadded. */
const REAL = "Zm9yZ2Utd2luZG93cy1nYy1saW5rLXRva2VuLTMyYnl0ZXM";

describe("looksLikeGcToken", () => {
  it("accepts a real one", () => {
    expect(looksLikeGcToken(REAL)).toBe(true);
    expect(REAL).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects anything that is not the base64url alphabet", () => {
    // '+' and '/' are the STANDARD base64 alphabet, which create_gc_link
    // translates away precisely so a token survives being pasted into a URL.
    expect(looksLikeGcToken(`${REAL.slice(0, 42)}+`)).toBe(false);
    expect(looksLikeGcToken(`${REAL.slice(0, 42)}/`)).toBe(false);
    expect(looksLikeGcToken(`${REAL.slice(0, 42)}=`)).toBe(false);
  });

  it("rejects anything too short to be 32 random bytes", () => {
    expect(looksLikeGcToken("abc")).toBe(false);
    expect(looksLikeGcToken("")).toBe(false);
    expect(looksLikeGcToken(null)).toBe(false);
    expect(looksLikeGcToken(undefined)).toBe(false);
  });
});

describe("gcTokenFromPath", () => {
  it("finds the token on the custom domain", () => {
    expect(gcTokenFromPath(`/gc/${REAL}`, "/")).toBe(REAL);
    // A trailing slash is what a phone's browser adds when somebody edits the
    // address bar, and it must not cost the builder the page.
    expect(gcTokenFromPath(`/gc/${REAL}/`, "/")).toBe(REAL);
  });

  it("finds the token under the GitHub Pages subpath", () => {
    // The app is served from /infinity-windows/ until PAGES_DOMAIN flips, and
    // Pages hands 404.html the URL the visitor actually asked for — so the
    // prefix is really there and really has to come off.
    expect(gcTokenFromPath(`/infinity-windows/gc/${REAL}`, "/infinity-windows/")).toBe(REAL);
  });

  it("is null for every other page in the app", () => {
    expect(gcTokenFromPath("/", "/")).toBeNull();
    expect(gcTokenFromPath("/projects", "/")).toBeNull();
    expect(gcTokenFromPath("/gc", "/")).toBeNull();
    expect(gcTokenFromPath("/gc/", "/")).toBeNull();
    // A path that is shaped right but carries junk is not a token, and must
    // fall through to the ordinary app rather than opening a broken GC page.
    expect(gcTokenFromPath("/gc/hello", "/")).toBeNull();
  });

  it("does not mistake a deeper path for a token", () => {
    expect(gcTokenFromPath(`/gc/${REAL}/answers`, "/")).toBeNull();
  });
});

describe("gcLinkUrl", () => {
  it("builds the address from wherever the app is being served", () => {
    expect(gcLinkUrl("https://app.forgewd.com", "/", REAL)).toBe(
      `https://app.forgewd.com/gc/${REAL}`,
    );
    expect(
      gcLinkUrl("https://infinity-windows.github.io", "/infinity-windows/", REAL),
    ).toBe(`https://infinity-windows.github.io/infinity-windows/gc/${REAL}`);
  });

  it("never doubles a slash", () => {
    // The origin arrives from window.location.origin, which has no trailing
    // slash — but a caller passing one should not produce a URL with '//' in
    // the middle, which some mail clients decline to linkify.
    expect(gcLinkUrl("https://app.forgewd.com/", "/", REAL)).toBe(
      `https://app.forgewd.com/gc/${REAL}`,
    );
  });

  it("round-trips: what we send is what the router reads back", () => {
    // The one property that actually matters. If these two ever disagree, the
    // link in the builder's email opens the sign-in screen.
    const url = gcLinkUrl("https://app.forgewd.com", "/infinity-windows/", REAL);
    const path = new URL(url).pathname;
    expect(gcTokenFromPath(path, "/infinity-windows/")).toBe(REAL);
  });
});

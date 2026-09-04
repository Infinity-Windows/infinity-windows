// The GC link's token, on the browser side (Wave H, H2).
//
// A token is 32 random bytes rendered base64url — 43 characters of
// [A-Za-z0-9_-] — minted by create_gc_link and handed to a general contractor
// in a text message or an email. The app never hashes it: the plaintext goes
// straight to the gc-link edge function, which hashes it and looks up the
// stored sha256. supabase/functions/_shared/gcToken.ts is the twin of the shape
// rule here, and holds the hashing; two copies because Deno cannot import from
// the app bundle.
//
// Pure string functions, no browser globals, so the router can call them at
// import time and a test can exercise them without a DOM.

import { normalizeBase } from "./pwa/basePaths";

/** [A-Za-z0-9_-], the base64url alphabet with the padding stripped. A range
 * rather than exactly 43, so a future token length is not a silent 404. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40,64}$/;

/** Is this even shaped like one of our tokens? */
export function looksLikeGcToken(token: string | null | undefined): boolean {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

/**
 * The token in `/gc/<token>`, read off the address the browser actually opened
 * — or null for every other path in the app.
 *
 * Read at STARTUP, before the router and before the session, because a general
 * contractor has no account and must not sit behind "Connecting…" while the app
 * asks Supabase who he is. That is the same reasoning that puts the crew
 * invite's `?join=` code ahead of everything, and the reason the path is
 * matched here by hand rather than by a <Route>.
 *
 * `base` is Vite's BASE_URL, so this works both on the GitHub Pages subpath
 * (/infinity-windows/gc/<token>) and on the custom domain (/gc/<token>). Pages
 * serves 404.html — a byte-copy of index.html — for any unmatched path, which
 * is what makes a deep link like this reach the app at all (vite.config.ts).
 */
export function gcTokenFromPath(pathname: string, base?: string | null): string | null {
  const prefix = normalizeBase(base);
  const path = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname.replace(/^\/+/, "");
  const match = /^gc\/([^/?#]+)\/?$/.exec(path);
  const token = match?.[1] ?? null;
  return token && looksLikeGcToken(token) ? token : null;
}

/**
 * The address to text or email a GC, built from wherever this app is being
 * served from right now.
 *
 * Derived rather than hardcoded so the same button is right on github.io today
 * and on the custom domain the moment PAGES_DOMAIN flips — a pasted constant
 * would send a customer to a 404 on the day of the cutover, and nobody would
 * find out until he said the link was broken.
 */
export function gcLinkUrl(origin: string, base: string | null | undefined, token: string): string {
  return `${origin.replace(/\/+$/, "")}${normalizeBase(base)}gc/${token}`;
}

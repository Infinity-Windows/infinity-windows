// Everything that has to change when the app is NOT served from the domain root.
//
// The live site is GitHub Pages at https://infinity-windows.github.io/infinity-windows/
// — a SUBPATH. Locally the same app is served from `/`. Anything written as a
// root-absolute `/...` is therefore correct in exactly one of those two places
// and silently wrong in the other, and "silently" is the problem: a manifest
// pointing at `/` still installs, still gets a home-screen icon, and only fails
// when you tap it, with GitHub's own 404 page. That is the bug this file exists
// to make impossible.
//
// Pure string functions, no browser and no import.meta, so vite.config.ts can
// import them at build time to emit the manifest AND the app/service worker can
// import them at runtime — one definition of "where does this live", used by
// both, and unit-testable without a phone.

/**
 * A base path with exactly one leading and one trailing slash.
 *
 * Vite hands us `/` or `/infinity-windows/`, but VITE_BASE is typed by whoever
 * sets the env var, so accept the near-misses (`infinity-windows`, `/x`, ``)
 * rather than emitting a manifest that is subtly wrong.
 */
export function normalizeBase(base: string | undefined | null): string {
  const trimmed = (base ?? "").trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

/**
 * Turn an in-app path (`/crew`, `crew`, `/icon-192.png`) into a path that is
 * correct under `base`. Query strings and fragments ride along untouched.
 */
export function withBase(base: string | undefined | null, path: string): string {
  return `${normalizeBase(base)}${path.replace(/^\/+/, "")}`;
}

/**
 * What BrowserRouter must be told the app is mounted under, so that a deep link
 * like `/infinity-windows/crew` is matched as the route `/crew`.
 *
 * This is the other half of the 404 fallback: Pages hands the SPA the URL the
 * user actually asked for, and without the basename the router would match none
 * of its routes and the catch-all would bounce them to Home — the deep link
 * would look like it worked while quietly going nowhere.
 *
 * React Router wants no trailing slash ("/infinity-windows"), and "/" for root.
 */
export function routerBasename(base: string | undefined | null): string {
  const normalized = normalizeBase(base);
  return normalized === "/" ? "/" : normalized.replace(/\/$/, "");
}

/** One entry in the manifest's `icons` array. */
export interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

/** The subset of the web app manifest this app publishes. */
export interface WebManifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: WebManifestIcon[];
}

/**
 * The manifest for a given base.
 *
 * `start_url` is what the home-screen icon opens — pointing it at `/` is what
 * gave Taylor a 404. `scope` is what the OS considers "inside the app": without
 * it, scope defaults to the manifest's own directory, which happens to be right
 * here, but stating it means a link that leaves the app opens in the browser
 * instead of quietly taking the standalone window somewhere it cannot come back
 * from. Icons must resolve too, or the installed app gets a blank glyph.
 */
export function buildWebManifest(base: string | undefined | null): WebManifest {
  return {
    name: "Infinity Windows & Doors",
    short_name: "Infinity",
    start_url: withBase(base, ""),
    scope: withBase(base, ""),
    display: "standalone",
    background_color: "#0C0B0A",
    theme_color: "#0C0B0A",
    icons: [
      { src: withBase(base, "icon-192.png"), sizes: "192x192", type: "image/png" },
      { src: withBase(base, "icon-512.png"), sizes: "512x512", type: "image/png" },
    ],
  };
}

/** Serialized manifest, ready to write to disk or answer a request with. */
export function renderWebManifest(base: string | undefined | null): string {
  return `${JSON.stringify(buildWebManifest(base), null, 2)}\n`;
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Where a notification click should actually land.
 *
 * Callers write the deep link the way the router sees it (`/clock`,
 * `/projects/x?tab=chat`) because that is what the rest of the app uses. In the
 * service worker those become real navigations, where `/clock` means the domain
 * root and misses the app entirely on a subpath. Resolving against the worker's
 * own scope fixes every call site at once, without asking each one to remember.
 *
 * A few callers already build a full `https://…` URL; those pass through, as
 * does a path that is already inside the scope, so nothing gets prefixed twice.
 */
export function resolveNotificationUrl(
  url: string | undefined | null,
  scope: string,
): string {
  if (!url) return scope;
  if (ABSOLUTE_URL.test(url)) return url;
  try {
    const scopeUrl = new URL(scope);
    const alreadyScoped = url.startsWith(scopeUrl.pathname);
    const target = alreadyScoped ? url.slice(scopeUrl.pathname.length) : url;
    return new URL(target.replace(/^\/+/, ""), scopeUrl).href;
  } catch {
    // A scope we cannot parse is not worth losing the notification over.
    return url;
  }
}

/**
 * The page-side stand-in for a service worker's `registration.scope`: the
 * app's full URL, origin plus base. The local-notification fallback (no SW
 * registration yet — first visit, private browsing) clicks through on the
 * page itself, and its `window.location.assign` needs the same resolution
 * the worker gets, or `/clock` navigates to the domain root and misses the
 * app. Feed this to resolveNotificationUrl as its `scope`.
 */
export function pageScopeUrl(
  origin: string,
  base: string | undefined | null,
): string {
  return origin.replace(/\/+$/, "") + normalizeBase(base);
}

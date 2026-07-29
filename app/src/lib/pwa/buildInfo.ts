// Which build this bundle is, and how to ask which build is published.
//
// `__BUILD_ID__` is substituted at compile time by vite.config.ts — the commit
// sha in CI, a `dev-<timestamp>` locally. The same value is written into
// version.json by the same config, so the two cannot disagree.

declare const __BUILD_ID__: string;
declare const __BUILT_AT__: string;

/** Build id compiled into this bundle. */
export const BUILD_ID: string =
  typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "";

/** When this bundle was built (ISO 8601), or "" if unknown. */
export const BUILT_AT: string =
  typeof __BUILT_AT__ === "string" ? __BUILT_AT__ : "";

/** Where version.json sits. Respects the Pages base path. */
export function versionUrl(baseUrl: string = import.meta.env.BASE_URL): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}version.json`;
}

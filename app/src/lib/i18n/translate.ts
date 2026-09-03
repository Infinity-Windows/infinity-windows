// The pure core of the language layer: no React, no storage, no network — just
// the rules for turning a key into a string in the active language. Everything
// here is unit-tested directly (i18n.test.ts) because it is the part that must
// never surprise an installer: a missing translation shows English, never a raw
// key, and an unknown key shows nothing rather than leaking "clock.title.main"
// onto a phone in the field.

/** The two languages the app speaks. Mirrors the profiles.language CHECK. */
export type Lang = "en" | "es";

export const LANGS: readonly Lang[] = ["en", "es"] as const;

/**
 * Every seeded string carries BOTH languages — that is the whole point of this
 * slice: later slices write English and Spanish together, never English alone.
 * `es` is required so a missing translation is a compile error, not a silent
 * English fallback that ships to a Spanish-reading crew.
 */
export interface CatalogEntry {
  en: string;
  es: string;
}

/** A dictionary keyed by dotted string keys. */
export type Catalog = Record<string, CatalogEntry>;

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "es";
}

/** Any raw value → a valid Lang, defaulting to English. */
export function normalizeLang(value: unknown): Lang {
  return isLang(value) ? value : "en";
}

/**
 * The active language, resolved in the order the whole app relies on: the
 * profile's stored language once it has loaded, else a per-device cache (so the
 * very first paint is already in the right language, before any query returns),
 * else English. Raw/unknown values at either step are skipped, never rendered.
 */
export function resolveLanguage(
  profileLang: string | null | undefined,
  cachedLang: string | null | undefined,
): Lang {
  if (isLang(profileLang)) return profileLang;
  if (isLang(cachedLang)) return cachedLang;
  return "en";
}

/** Values allowed in a t() interpolation. */
export type TVars = Record<string, string | number>;

/**
 * Replace `{name}` placeholders with their value. An unmatched placeholder is
 * left as-is rather than blanked, so a copy bug reads as "{code}" (obvious in
 * review) instead of a confusing empty gap. Nothing here is a format string, so
 * there is no escaping to get wrong.
 */
export function interpolate(template: string, vars?: TVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}

/**
 * The lookup itself. In order:
 *   1. Unknown key → "" — NEVER the bare key. A key that somehow escapes the
 *      typed catalog must not surface to a person.
 *   2. Known key → the active language, falling back to English when a
 *      translation is absent. (Seeded entries carry both, so this fallback is a
 *      safety net for hand-built or partially-typed catalogs, not the norm.)
 *   3. Interpolate {vars}.
 */
export function translate(
  catalog: Catalog,
  lang: Lang,
  key: string,
  vars?: TVars,
): string {
  const entry = catalog[key];
  if (!entry) return "";
  const template = entry[lang] ?? entry.en;
  return interpolate(template ?? "", vars);
}

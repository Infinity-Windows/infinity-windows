// The language layer's rules, tested where they live — the pure core, plus the
// promise the whole slice rests on: every seeded crew-flow key exists in BOTH
// languages, and the safety strings are present in both (their WORDS still get a
// bilingual review; this proves they are never missing).

import { describe, expect, it } from "vitest";
import {
  interpolate,
  isLang,
  normalizeLang,
  resolveLanguage,
  translate,
  type Catalog,
} from "./translate";
import { CATALOG, SAFETY_KEYS } from "./catalog";

describe("translate()", () => {
  const cat: Catalog = {
    "greet.hi": { en: "Hello", es: "Hola" },
    "greet.bye": { en: "Bye", es: "Adiós" },
  };

  it("returns the active language's string", () => {
    expect(translate(cat, "es", "greet.hi")).toBe("Hola");
    expect(translate(cat, "en", "greet.hi")).toBe("Hello");
  });

  it("falls back to English when the translation is missing", () => {
    // An entry with no Spanish (as a partial/hand-built catalog might have):
    // Spanish requests fall through to English rather than blank or a key.
    const partial = { "only.en": { en: "English only" } } as unknown as Catalog;
    expect(translate(partial, "es", "only.en")).toBe("English only");
  });

  it("NEVER returns the bare key for an unknown key — returns empty", () => {
    expect(translate(cat, "en", "does.not.exist")).toBe("");
    expect(translate(cat, "es", "does.not.exist")).toBe("");
    expect(translate(cat, "es", "does.not.exist")).not.toBe("does.not.exist");
  });

  it("interpolates {vars}", () => {
    const c: Catalog = {
      "clock.startOn": { en: "Start on {code}", es: "Empieza en {code}" },
    };
    expect(translate(c, "en", "clock.startOn", { code: "12-2" })).toBe(
      "Start on 12-2",
    );
    expect(translate(c, "es", "clock.startOn", { code: "12-2" })).toBe(
      "Empieza en 12-2",
    );
  });
});

describe("interpolate()", () => {
  it("replaces named placeholders and stringifies numbers", () => {
    expect(interpolate("Done today ({count})", { count: 3 })).toBe(
      "Done today (3)",
    );
    expect(interpolate("{a} and {b}", { a: "x", b: "y" })).toBe("x and y");
  });

  it("leaves an unmatched placeholder in place rather than blanking it", () => {
    expect(interpolate("Hi {name}", {})).toBe("Hi {name}");
  });

  it("returns the template untouched with no vars", () => {
    expect(interpolate("plain")).toBe("plain");
  });
});

describe("isLang() / normalizeLang()", () => {
  it("accepts only en and es", () => {
    expect(isLang("en")).toBe(true);
    expect(isLang("es")).toBe(true);
    expect(isLang("fr")).toBe(false);
    expect(isLang(null)).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });

  it("normalizes any raw value to a valid language, defaulting to en", () => {
    expect(normalizeLang("es")).toBe("es");
    expect(normalizeLang("fr")).toBe("en");
    expect(normalizeLang(null)).toBe("en");
    expect(normalizeLang(42)).toBe("en");
  });
});

describe("resolveLanguage(): profile → cache → 'en'", () => {
  it("prefers the profile's language once loaded", () => {
    expect(resolveLanguage("es", "en")).toBe("es");
    expect(resolveLanguage("en", "es")).toBe("en");
  });

  it("uses the cache when the profile has not loaded", () => {
    expect(resolveLanguage(null, "es")).toBe("es");
    expect(resolveLanguage(undefined, "es")).toBe("es");
  });

  it("defaults to English when neither is a valid language", () => {
    expect(resolveLanguage(null, null)).toBe("en");
    expect(resolveLanguage("garbage", "also-bad")).toBe("en");
  });
});

describe("the seeded crew-flow catalog", () => {
  const keys = Object.keys(CATALOG) as (keyof typeof CATALOG)[];

  it("has entries", () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it("carries BOTH languages for every key — non-empty en AND es", () => {
    for (const key of keys) {
      const entry = CATALOG[key];
      expect(entry.en, `en for ${key}`).toBeTruthy();
      expect(entry.es, `es for ${key}`).toBeTruthy();
    }
  });

  it("has both locales present for every SAFETY key", () => {
    for (const key of SAFETY_KEYS) {
      const entry = CATALOG[key];
      expect(entry, `safety key ${key} exists in the catalog`).toBeDefined();
      expect(entry.en, `en for safety key ${key}`).toBeTruthy();
      expect(entry.es, `es for safety key ${key}`).toBeTruthy();
    }
  });

  it("interpolates the seeded crew-flow key in both languages", () => {
    // A real seeded key with a {var} — proves the wiring end to end.
    expect(translate(CATALOG, "en", "clock.action.startOn", { code: "1A" })).toBe(
      "Start clock on 1A",
    );
    expect(translate(CATALOG, "es", "clock.action.startOn", { code: "1A" })).toBe(
      "Marca entrada en 1A",
    );
  });
});

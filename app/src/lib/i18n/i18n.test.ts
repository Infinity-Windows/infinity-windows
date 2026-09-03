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
import { buildDeleteConfirmMessage } from "../projectTrash";

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

// The slice-7 promise: with the whole crew flow now going through t(), NOTHING
// on it falls back to English when the language is Spanish, and the strings the
// last cleanup wrapped resolve to real Spanish — not the key, not the English.
describe("the crew flow reads fully in Spanish (slice 7)", () => {
  const keys = Object.keys(CATALOG) as (keyof typeof CATALOG)[];

  it("returns the Spanish string for EVERY key under es — never the English fallback", () => {
    for (const key of keys) {
      // translate() falls back to en only when es is absent; every entry ships
      // es, so this proves no crew-flow key silently shows English to a Spanish
      // reader.
      expect(translate(CATALOG, "es", key), `es for ${key}`).toBe(CATALOG[key].es);
    }
  });

  it("resolves the newly-wrapped keys to real Spanish, distinct from English", () => {
    const samples: Array<[keyof typeof CATALOG, string, string]> = [
      ["jobcost.loading", "Loading…", "Cargando…"],
      ["buildout.thisJob", "this job", "este trabajo"],
      ["feed.trash", "Trash", "Papelera"],
      ["feed.photoTrashed",
        "Photo moved to trash — 30 days to undo.",
        "Foto movida a la papelera — 30 días para deshacer."],
      ["feed.addPhoto", "Add photo", "Agregar foto"],
      ["clock.toast.clockedIn", "Clocked in", "Entrada marcada"],
      ["clock.a11y.timeClock", "Time clock", "Reloj de tiempo"],
      ["summon.a11y.live", "Live summons", "Llamadas activas"],
      ["mywork.jobToday", "Your job today", "Tu trabajo de hoy"],
      ["mywork.loadError", "Couldn't load your work", "No se pudo cargar tu trabajo"],
      ["deljob.delete", "Delete…", "Eliminar…"],
    ];
    for (const [key, en, es] of samples) {
      expect(translate(CATALOG, "en", key)).toBe(en);
      expect(translate(CATALOG, "es", key)).toBe(es);
      expect(translate(CATALOG, "es", key)).not.toBe(en);
    }
  });

  it("interpolates the new plural / var keys in Spanish", () => {
    expect(translate(CATALOG, "es", "mywork.newUnits.one", { count: 1 })).toBe(
      "1 unidad nueva asignada a ti — toca para descartar",
    );
    expect(translate(CATALOG, "es", "mywork.newUnits.many", { count: 3 })).toBe(
      "3 unidades nuevas asignadas a ti — toca para descartar",
    );
    expect(translate(CATALOG, "es", "mywork.unsubmitTitle", { code: "1-2" })).toBe(
      "¿Deshacer el envío de 1-2?",
    );
  });

  it("builds the delete-job confirm fully in Spanish — no English words leak", () => {
    // The dialog assembles its count sentence from the catalog; the regular +s
    // plural covers abertura/paquete/foto, so a Spanish reader gets a clean,
    // fully-Spanish confirmation (the exact wiring Projects.tsx uses).
    const msg = buildDeleteConfirmMessage(
      "PECAN14",
      { openings: 2, packages: 1, photos: 0 },
      {
        opening: translate(CATALOG, "es", "deljob.word.opening"),
        package: translate(CATALOG, "es", "deljob.word.package"),
        photo: translate(CATALOG, "es", "deljob.word.photo"),
        template: translate(CATALOG, "es", "deljob.confirmTemplate"),
      },
    );
    expect(msg).toContain("¿Eliminar PECAN14?");
    expect(msg).toContain("2 aberturas");
    expect(msg).toContain("1 paquete"); // singular, no trailing s
    expect(msg).toContain("0 fotos");
    expect(msg).not.toMatch(/opening|package|photo|Delete/);
  });
});

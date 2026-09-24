import { describe, expect, it } from "vitest";
import { CATALOG, SAFETY_KEYS } from "./catalog";
import { translate } from "./translate";
import { WORK_CATALOG } from "./workCatalog";

describe("the Work screen's lazy phrasebook", () => {
  it("ships every string in English AND Spanish, and the two differ", () => {
    for (const [key, entry] of Object.entries(WORK_CATALOG)) {
      expect(entry.en.trim(), `en for ${key}`).not.toBe("");
      expect(entry.es.trim(), `es for ${key}`).not.toBe("");
    }
    // Not a per-key rule (a few words are the same in both languages), but
    // the phrasebook as a whole must actually be translated.
    const same = Object.values(WORK_CATALOG).filter((e) => e.en === e.es).length;
    expect(same).toBeLessThan(Object.keys(WORK_CATALOG).length / 10);
  });

  it("registers itself into the live catalog on load, so t() finds it", () => {
    expect(translate(CATALOG, "en", "work.clock.startDay")).toBe("Start day");
    expect(translate(CATALOG, "es", "work.clock.startDay")).toBe("Iniciar el día");
    expect(translate(CATALOG, "es", "work.headsUp.photo.many", { n: 3 })).toContain("3 fotos");
  });

  it("keeps the Start day safety lines on the bilingual-review list", () => {
    for (const key of ["work.clock.willOpenTalk", "work.clock.paidFromTap", "work.toolbox.locked", "work.headsUp.toolbox", "work.prep.locked", "work.prep.refused"]) {
      expect(SAFETY_KEYS as readonly string[]).toContain(key);
      expect(key in WORK_CATALOG).toBe(true);
    }
  });

  it("never collides with a key the main catalog already owns", () => {
    // CATALOG has been mutated by registration by now, so compare against
    // the keys that are NOT from this file.
    const workKeys = new Set(Object.keys(WORK_CATALOG));
    const mainKeys = Object.keys(CATALOG).filter((k) => !workKeys.has(k));
    for (const k of mainKeys) expect(k.startsWith("work.")).toBe(false);
  });
});

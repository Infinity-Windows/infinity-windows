// pdfSafeText is the one gate between free text and pdf-lib's standard fonts,
// which throw on any character outside WinAnsi (see pdfText.ts for the crew
// report that made it necessary). The first test is the one that matters most:
// Spanish and the punctuation the font DOES have must come through untouched,
// or the fix would quietly damage every talk the crew reads in Spanish.

import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { pdfSafeText } from "./pdfText";

let regular: PDFFont;
let bold: PDFFont;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  regular = await doc.embedFont(StandardFonts.Helvetica);
  bold = await doc.embedFont(StandardFonts.HelveticaBold);
});

describe("pdfSafeText", () => {
  it("keeps Spanish and the WinAnsi punctuation exactly as written", () => {
    const text =
      "¿Dónde está? ¡Sí! Niño, año, pingüino, ÁÉÍÓÚÜÑ — “comillas” ‘simples’ … • € ™ © ® ° ± × ½ 36\"x48' ~ ^ | @ #";
    expect(pdfSafeText(text, regular)).toBe(text);
    expect(pdfSafeText(text, bold)).toBe(text);
  });

  it("spells check marks, arrows and comparisons in plain text", () => {
    expect(pdfSafeText("✓ ✔ ☑ ✗ ✘ ☒", regular)).toBe("+ + + x x x");
    expect(pdfSafeText("a → b ← c ↔ d ⇒ e ➡ f", regular)).toBe("a -> b <- c <-> d => e -> f");
    expect(pdfSafeText("RPM ≥ 11000, temp ≤ 40°F, ≠ 0, ≈ 5", regular)).toBe(
      "RPM >= 11000, temp <= 40°F, != 0, ~ 5",
    );
  });

  it("turns look-alike dashes, minus and primes into their ASCII", () => {
    // hyphen, non-breaking hyphen, figure dash, minus, prime, double prime
    const lookAlikes = "a\u{2010}b\u{2011}c\u{2012}d \u{2212}5 6\u{2032}8\u{2033}";
    expect(pdfSafeText(lookAlikes, regular)).toBe("a-b-c-d -5 6'8\"");
    // An en and an em dash are in the font, so they stay.
    expect(pdfSafeText("2–3 — ok", regular)).toBe("2–3 — ok");
  });

  it("drops emoji whole: ZWJ sequences, skin tones, flags, keycaps, presentation selectors", () => {
    expect(pdfSafeText("Hard hat 👷‍♀️ on", regular)).toBe("Hard hat  on");
    expect(pdfSafeText("Good 👍🏽 job", regular)).toBe("Good  job");
    expect(pdfSafeText("Crew 🇲🇽🇺🇸", regular)).toBe("Crew ");
    expect(pdfSafeText("Step 1️⃣", regular)).toBe("Step 1");
    expect(pdfSafeText("Gloves ✅ Phones ❌ ⚠️", regular)).toBe("Gloves  Phones  ");
    // A check mark sent with the emoji selector is still a check mark.
    expect(pdfSafeText("✔️ done", regular)).toBe("+ done");
  });

  it("turns tabs and line breaks into spaces and removes invisible marks", () => {
    expect(pdfSafeText("a\tb\nc\r\nd", regular)).toBe("a b c  d");
    expect(pdfSafeText("wide\u{3000}thin\u{202F}space", regular)).toBe("wide thin space");
    expect(pdfSafeText("zero\u{200B}width\u{FEFF}\u{200E}", regular)).toBe("zerowidth");
    // The no-break space is in the font and stays.
    expect(pdfSafeText("10\u{A0}ft", regular)).toBe("10\u{A0}ft");
  });

  it("composes an accent typed separately onto its letter", () => {
    expect(pdfSafeText("Pe\u{301}rez Mun\u{303}oz", regular)).toBe("Pérez Muñoz");
  });

  it("falls back to the plain letter, then to ?", () => {
    expect(pdfSafeText("Nguyễn", regular)).toBe("Nguyen");
    expect(pdfSafeText("ﬁre ①Ａ x⁴ ⅓", regular)).toBe("fire 1A x4 1/3");
    expect(pdfSafeText("日本 Ω", regular)).toBe("?? ?");
  });

  it("returns only characters the font can draw and measure, for every character", () => {
    const charset = new Set(regular.getCharacterSet());
    const samples: string[] = [];
    // Every BMP code unit (a stray half of a surrogate pair included), plus
    // the emoji planes.
    for (let cp = 0; cp < 0x10000; cp++) samples.push(String.fromCodePoint(cp));
    for (let cp = 0x1f000; cp < 0x1fb00; cp++) samples.push(String.fromCodePoint(cp));

    const bad = samples.filter((s) =>
      [...pdfSafeText(s, regular)].some((ch) => !charset.has(ch.codePointAt(0)!)),
    );
    expect(bad).toEqual([]);
    expect(() => regular.widthOfTextAtSize(pdfSafeText(samples.join(""), regular), 11)).not.toThrow();
  });
});

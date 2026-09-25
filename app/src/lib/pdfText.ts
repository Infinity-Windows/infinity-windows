// Text for PDFs drawn with pdf-lib's built-in fonts.
//
// Helvetica and the other standard fonts carry the WinAnsi character set and
// nothing more: ASCII, the Latin-1 letters (every Spanish accent, ñ, ¿ and ¡),
// and a couple of dozen extras such as – — ‘ ’ “ ” • … € ™. Hand pdf-lib any
// other character, to draw OR to measure, and it throws "WinAnsi cannot encode"
// and the whole document fails with it. That is how a ✓ in the toolbox talk's
// Do list stopped the crew signing, and so clocking in (crew report,
// 2026-09-06).
//
// Embedding a Unicode font instead would ship a font file to every phone for a
// record that is rarely opened. Spelling the few symbols that actually turn up
// in plain text, and dropping emoji, keeps every word of the talk readable.
import type { PDFFont } from "pdf-lib";

/**
 * Symbols seen in talk text and on phone keyboards, spelled the way someone on
 * the jobsite would write them by hand. The look-alike dashes and primes are
 * escaped so a reviewer can tell them from the ASCII they become.
 */
const SUBSTITUTES: Readonly<Record<string, string>> = {
  "✓": "+",
  "✔": "+",
  "☑": "+",
  "✗": "x",
  "✘": "x",
  "☒": "x",
  "→": "->",
  "➔": "->",
  "➜": "->",
  "➡": "->",
  "←": "<-",
  "↔": "<->",
  "⇒": "=>",
  "≥": ">=",
  "≤": "<=",
  "≠": "!=",
  "≈": "~",
  "\u{2010}": "-", // hyphen
  "\u{2011}": "-", // non-breaking hyphen
  "\u{2012}": "-", // figure dash
  "\u{2212}": "-", // minus sign
  "\u{2032}": "'", // prime: feet
  "\u{2033}": '"', // double prime: inches
  "\u{2044}": "/", // fraction slash, which is what ⅓ decomposes to
};

/** Tabs, line breaks and the Unicode spaces the font has no glyph for. */
const SPACE = /[\t\n\v\f\r\p{Zs}\u{2028}\u{2029}]/u;

/**
 * Characters that carry no words: control and zero-width formatting marks,
 * combining marks left over after composing (which include the emoji
 * presentation selector and the keycap), emoji, skin tones and flag letters.
 */
const DROP =
  /[\p{Cc}\p{Cf}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/u;

const charsets = new WeakMap<PDFFont, ReadonlySet<number>>();

function charsetOf(font: PDFFont): ReadonlySet<number> {
  let set = charsets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charsets.set(font, set);
  }
  return set;
}

/** The character itself when the font has it, its plain-text spelling, or null. */
function direct(ch: string, charset: ReadonlySet<number>): string | null {
  if (charset.has(ch.codePointAt(0)!)) return ch;
  return SUBSTITUTES[ch] ?? null;
}

/**
 * `text` rewritten so `font` can draw and measure every character of it.
 *
 * Whatever the font can draw is kept exactly, so Spanish and the WinAnsi
 * punctuation come through untouched. The rest becomes, in order of
 * preference: a plain-text spelling (✓ to +, → to ->, ≥ to >=), a space
 * (tabs, line breaks), nothing (emoji, zero-width marks), the letter without
 * its accent (ễ to e, as in Nguyen), or "?" as the last resort.
 *
 * Every string the toolbox PDF draws or measures goes through this.
 */
export function pdfSafeText(text: string, font: PDFFont): string {
  const charset = charsetOf(font);
  let out = "";
  // Composing first turns an "e" typed with a separate accent into the é the
  // font has, instead of an e with the accent dropped.
  for (const ch of text.normalize("NFC")) {
    const kept = direct(ch, charset);
    if (kept !== null) {
      out += kept;
    } else if (SPACE.test(ch)) {
      out += " ";
    } else if (DROP.test(ch)) {
      // Nothing to draw.
    } else {
      out += decomposed(ch, charset) ?? "?";
    }
  }
  return out;
}

/** A letter or symbol spelled from its compatibility parts, when all of them can be drawn. */
function decomposed(ch: string, charset: ReadonlySet<number>): string | null {
  let out = "";
  for (const part of ch.normalize("NFKD")) {
    if (/\p{M}/u.test(part)) continue;
    const kept = direct(part, charset);
    if (kept === null) return null;
    out += kept;
  }
  return out || null;
}

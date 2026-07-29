/** Where an answer came from. Shown to the crew so a foreman can correct it. */
export type BrainKind = "tip" | "watch-out" | "type" | "glossary" | "procedure" | "app";

/**
 * One searchable thing the company already knows. Everything the brain can say
 * is an entry: a seeded install tip, a watch-out, a catalog type card, a
 * glossary term, a procedure step. Nothing is generated, so the brain cannot
 * invent an instruction — it can only show a sentence a human wrote.
 */
export interface BrainEntry {
  id: string;
  kind: BrainKind;
  /** Heading shown above the answer. */
  title: string;
  /** Citation line — "SH3252 · Single-Hung 32x52", "Glossary · Sealing". */
  source: string;
  /** The answer itself. */
  body: string;
  /**
   * Text to index instead of `body`. A window-type card *shows* all of its tips
   * but indexes none of them, so a question about caulking the bottom lands on
   * the sentence about caulking the bottom rather than on the whole type.
   */
  indexBody?: string;
  /** Extra words to index that aren't in the title or body (codes, synonyms). */
  keywords?: string[];
  /** In-app route the crew can tap to see more. */
  href?: string;
  /**
   * True for the app tour. It only competes when the question is actually about
   * using the app — never as a catch-all for a knowledge question, which is the
   * single biggest source of wrong answers in the version this replaces.
   */
  appOnly?: boolean;
}

/** A window type in the bundled catalog snapshot. Short keys to keep it small. */
export interface CatalogType {
  /** type_code */
  c: string;
  /** name */
  n: string;
  /** category */
  cat?: string;
  /** width_in */
  w?: number;
  /** height_in */
  h?: number;
  /** difficulty_rating, 1–5 */
  d?: number;
  /** free-text notes */
  note?: string;
  /** tips_json */
  t?: string[];
  /** watch_outs_json */
  x?: string[];
  /** howto_json — generated step-by-steps, title + detail. */
  hw?: Array<{ t: string; d: string }>;
}

export interface BrainHit {
  entry: BrainEntry;
  score: number;
  /** Query words this entry actually matched — used by the tests and the UI. */
  matched: string[];
}

import { bigrams, tokenize } from "./tokenize";
import type { BrainEntry, BrainHit } from "./types";

/**
 * The local keyword index. No network, no model — it can only ever show a
 * sentence a human wrote, and it works with the phone in airplane mode.
 *
 * Scoring is deliberately plain: rarer words count for more, a title match
 * counts for more than a body match, matching more of the question counts for a
 * lot, and an adjacent word pair ("weep hole", "pressure plate") counts extra.
 */

/** How much a match in each part of an entry is worth. */
const FIELD_WEIGHT = { title: 3, keywords: 2.5, source: 1.5, body: 1 } as const;

/** An adjacent-pair match is strong evidence — "sill pan" is not "sill". */
const BIGRAM_BONUS = 3;

/**
 * "How heavy before I need a second man?" wants the sentence with 150 lb in it,
 * not the one that says "2-person lift". So when the question asks for a
 * quantity, an answer that actually states a measured figure scores higher.
 */
const QUANTITY_QUESTION =
  /\bhow (?:heavy|tight|many|much|far|deep|long|wide|tall|hot|cold)\b|\bwhat (?:torque|size|spacing|temperature|gap)\b|\bhow (?:big|thick)\b/;
const MEASURED_FIGURE =
  /\d\s*(?:["']|in\b|in-lb|inch|inches|lb\b|lbs\b|pound|ft\b|feet|mm\b|o\.?c\.?|%|deg|°|minute|min\b|hour|psf|psi)/i;
const QUANTITY_BONUS = 1.25;

/**
 * Fraction of the question's *information* an entry has to match before we show
 * it. This is what stops the brain answering "what did Ammon say last week?" —
 * it matches "job" and "week" and nothing that matters, so it stays quiet
 * instead of guessing. Silence is a safe answer; a confident irrelevant one is
 * what trained crew to stop asking.
 */
export const MIN_CONFIDENCE = 0.5;

/**
 * One matching word is not an answer, however rare that word is — matching only
 * "storm" is how "it's raining and the opening is open" came back with the ASTM
 * water test. Two words minimum as soon as the question has two to match.
 */
const MIN_MATCHED = 2;

/** How many answers to show. The investigation measured 21 of 28 useful within
 * three, and a keyword search's honest failure mode is "here are three, pick". */
export const RESULT_COUNT = 3;

interface IndexedEntry {
  entry: BrainEntry;
  /** token → accumulated field weight, log-dampened. */
  weights: Map<string, number>;
  pairs: Set<string>;
  /** Type code / glossary id — used to keep the three results distinct. */
  group: string;
  /** Whether the entry states a measured figure ("35–50 in-lb", "150 lb"). */
  measured: boolean;
}

export interface BrainIndex {
  entries: IndexedEntry[];
  idf: Map<string, number>;
  /** idf for a word the brain has never seen — the ceiling. */
  unseenIdf: number;
}

function addField(weights: Map<string, number>, text: string, weight: number): string[] {
  const words = tokenize(text);
  for (const w of words) weights.set(w, (weights.get(w) ?? 0) + weight);
  return words;
}

function groupKey(entry: BrainEntry): string {
  const code = entry.id.match(/^(?:type|tip|watch):([^:]+)/);
  return code ? `type:${code[1]}` : entry.id;
}

export function buildIndex(entries: BrainEntry[]): BrainIndex {
  const indexed: IndexedEntry[] = [];
  const df = new Map<string, number>();

  for (const entry of entries) {
    const weights = new Map<string, number>();
    const bodyWords = addField(weights, entry.indexBody ?? entry.body, FIELD_WEIGHT.body);
    const titleWords = addField(weights, entry.title, FIELD_WEIGHT.title);
    addField(weights, entry.source, FIELD_WEIGHT.source);
    for (const kw of entry.keywords ?? []) addField(weights, kw, FIELD_WEIGHT.keywords);

    // Dampen: an entry that says "level" six times is not six times as relevant.
    for (const [token, raw] of weights) weights.set(token, 1 + Math.log(raw));

    const pairs = new Set([...bigrams(titleWords), ...bigrams(bodyWords)]);
    for (const token of weights.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    indexed.push({
      entry,
      weights,
      pairs,
      group: groupKey(entry),
      measured: MEASURED_FIGURE.test(entry.indexBody ?? entry.body),
    });
  }

  const n = Math.max(indexed.length, 1);
  const idf = new Map<string, number>();
  for (const [token, count] of df) idf.set(token, Math.log(1 + n / count));
  return { entries: indexed, idf, unseenIdf: Math.log(1 + n) };
}

function idfOf(index: BrainIndex, token: string): number {
  return index.idf.get(token) ?? index.unseenIdf;
}

export interface SearchResult {
  hits: BrainHit[];
  /** True when nothing cleared MIN_CONFIDENCE — the brain says so honestly. */
  miss: boolean;
  /** Confidence of the best hit, 0–1. Exposed so the log can record it. */
  topConfidence: number;
}

/**
 * Search the brain. `appIntent` is false for every question that isn't about
 * using the app, which is what keeps the app tour from being handed out as an
 * answer to a question about caulking.
 */
export function searchBrain(
  index: BrainIndex,
  question: string,
  opts: { appIntent?: boolean; limit?: number } = {},
): SearchResult {
  const words = tokenize(question);
  const queryTokens = [...new Set(words)];
  if (queryTokens.length === 0) return { hits: [], miss: true, topConfidence: 0 };

  const queryPairs = new Set(bigrams(words));
  const queryMass = queryTokens.reduce((sum, t) => sum + idfOf(index, t), 0);
  const wantsFigure = QUANTITY_QUESTION.test(question.toLowerCase());

  const scored: Array<BrainHit & { confidence: number; group: string }> = [];
  for (const item of index.entries) {
    if (item.entry.appOnly && !opts.appIntent) continue;
    let score = 0;
    let matchedMass = 0;
    const matched: string[] = [];
    for (const token of queryTokens) {
      const weight = item.weights.get(token);
      if (weight == null) continue;
      const tokenIdf = idfOf(index, token);
      score += tokenIdf * weight;
      matchedMass += tokenIdf;
      matched.push(token);
    }
    if (matched.length === 0) continue;
    if (matched.length < Math.min(MIN_MATCHED, queryTokens.length)) continue;

    for (const pair of queryPairs) {
      if (!item.pairs.has(pair)) continue;
      const [a, b] = pair.split(" ");
      score += (BIGRAM_BONUS * (idfOf(index, a) + idfOf(index, b))) / 2;
    }

    // Matching more of the question matters more than matching one word hard.
    const coverage = matchedMass / queryMass;
    score *= 0.3 + 0.7 * coverage;
    if (wantsFigure && item.measured) score *= QUANTITY_BONUS;
    scored.push({
      entry: item.entry,
      score,
      matched,
      confidence: coverage,
      group: item.group,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  // One answer per window type / term, so three results are three real options
  // rather than the same tip three ways.
  const limit = opts.limit ?? RESULT_COUNT;
  const seen = new Set<string>();
  const hits: BrainHit[] = [];
  let topConfidence = 0;
  for (const hit of scored) {
    if (hit.confidence < MIN_CONFIDENCE) continue;
    topConfidence = Math.max(topConfidence, hit.confidence);
    if (seen.has(hit.group)) continue;
    seen.add(hit.group);
    hits.push({ entry: hit.entry, score: hit.score, matched: hit.matched });
    if (hits.length >= limit) break;
  }

  return { hits, miss: hits.length === 0, topConfidence };
}

/** Words that mean "I'm asking about the app", not about installing a window. */
const APP_INTENT = [
  /\b(app|tab|tabs|screen|screens|page|pages|button|buttons|menu|nav)\b/,
  /\b(clock in|clock out|clocking|timecard|time card)\b/,
  /\b(sign in|signin|log in|login|logged out|pin code)\b/,
  /\b(scan|qr)\b/,
  /\b(points|tier|leaderboard)\b/,
  /\b(upload|attach|record a memo|proof photo|proof photos)\b/,
  /\bhow do i use\b/,
  /\bwhere (?:do|is|are) .*\b(find|see|tap|start|assign)\b/,
];

/** Whether the app tour is even allowed to compete for this question. */
export function hasAppIntent(question: string): boolean {
  const q = question.toLowerCase();
  return APP_INTENT.some((re) => re.test(q));
}

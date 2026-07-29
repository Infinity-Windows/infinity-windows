import { buildEntries, bundledEntries } from "./entries";
import { buildIndex, hasAppIntent, searchBrain, type BrainIndex } from "./search";
import type { BrainHit, CatalogType } from "./types";

/**
 * The one way to ask the local brain a question. No network, no model, no API
 * key — it can only show sentences a human wrote, so it cannot invent a
 * flashing sequence, and it works with the phone in airplane mode.
 */

export type BrainOutcome =
  /** Up to three answers, best first, each citing where it came from. */
  | { kind: "answers"; hits: BrainHit[] }
  /** A question about today's jobs, not about craft. The brain holds no live data. */
  | { kind: "live"; message: string }
  /** Nobody has written this down. Say so, and log it so somebody can. */
  | { kind: "miss"; message: string };

/**
 * Questions about who said what, when, and on which job. The brain is written
 * craft knowledge; it has no idea what Ammon said last week, and guessing a
 * glossary term at it is worse than saying so.
 */
const LIVE_DATA_QUESTION = [
  /\b(?:what|who|when)\b[^?]*\b(?:said|say|says|told|asked|sent|posted|mentioned)\b/,
  /\b(?:last|next|this)\s+(?:week|month|monday|tuesday|wednesday|thursday|friday)\b/,
  /\b(?:yesterday|today|tomorrow|right now)\b/,
  /\bon (?:this|that|the) job\b/,
];

const LIVE_MESSAGE =
  "That's about a job rather than install technique, and the brain only holds what we've " +
  "written down about the craft. Check the job's chat, schedule or issues for that.";

const MISS_MESSAGE =
  "We haven't written that one down yet. I've logged the question so a foreman can add the " +
  "answer — ask them directly in the meantime rather than guessing.";

export function isLiveDataQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return LIVE_DATA_QUESTION.some((re) => re.test(q));
}

/** Ask the brain. Pure and synchronous — no awaiting, nothing to be offline for. */
export function askBrain(index: BrainIndex, question: string): BrainOutcome {
  if (!question.trim()) {
    return {
      kind: "miss",
      message: "Ask me about a window type, a term, or how to use any part of the app.",
    };
  }
  if (isLiveDataQuestion(question)) return { kind: "live", message: LIVE_MESSAGE };
  const { hits } = searchBrain(index, question, { appIntent: hasAppIntent(question) });
  if (hits.length === 0) return { kind: "miss", message: MISS_MESSAGE };
  return { kind: "answers", hits };
}

let cached: { catalog: CatalogType[] | null; index: BrainIndex } | null = null;

/**
 * The brain index, built once and reused. Pass a refreshed catalog (from the
 * cache the app fills whenever it has signal) to rebuild against it; pass
 * nothing to use the copy that ships in the bundle.
 */
export function getBrainIndex(catalog?: CatalogType[] | null): BrainIndex {
  if (cached && cached.catalog === (catalog ?? null)) return cached.index;
  const index = buildIndex(catalog ? buildEntries(catalog) : bundledEntries());
  cached = { catalog: catalog ?? null, index };
  return index;
}

/** Plain text for one answer, with its citation. */
export function formatHit(hit: BrainHit): string {
  return `${hit.entry.title}\n${hit.entry.body}`;
}

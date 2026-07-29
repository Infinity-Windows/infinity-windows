/**
 * Turning what an installer typed into words we can match.
 *
 * The version this replaces searched for the *entire question* as one phrase
 * inside a type code, which is why "single hung" found nothing (the catalog
 * spells it "Single-Hung") and why the app's own "Single hung tips" button
 * returned nothing at all. So: split into words, fold the ways installers
 * actually talk onto one another ("drain side" / "weep holes", "drags" /
 * "binds", "second man" / "two people"), and match on those.
 */

/** Words that carry no meaning for retrieval. "out", "off", "top" and "bottom"
 * stay, because "out of level" and "caulk the bottom" are real questions. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "i", "me", "my", "we", "our", "us", "you", "your", "it", "its", "they", "them", "their",
  "is", "am", "are", "was", "were", "be", "been", "being", "do", "does", "did", "doing", "done",
  "have", "has", "had", "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "to", "of", "in", "on", "at", "by", "as", "for", "from", "with", "into", "about",
  "what", "whats", "how", "when", "where", "which", "who", "whom", "why", "whose",
  "there", "here", "just", "any", "some", "one", "also", "get", "got", "go", "goes", "going",
  "very", "really", "please", "thanks", "ok", "okay", "yes", "no", "not", "now", "yet",
  "much", "many", "need", "needs", "needed", "want", "wants", "run", "runs", "put", "make",
  "makes", "know", "tell", "say", "says", "said", "thing", "things", "stuff", "supposed",
  "re", "vs", "etc",
]);

/**
 * Whole phrases installers use that mean something no single word in them does.
 * Rewritten before splitting into words, in the question and in the content, so
 * "how far back does it sit" and "what's the setout" find the same sentence.
 */
const PHRASES: Array<[RegExp, string]> = [
  [/\bhow far back\b/g, " depth "],
  [/\bsets? back\b/g, " depth "],
  [/\bsetting back\b/g, " depth "],
  [/\bset ?out\b/g, " depth "],
  [/\bset ?back\b/g, " depth "],
  [/\bsecond (?:man|guy|person|hand|body)\b/g, " person lift "],
  [/\bhow heavy\b/g, " lift weight "],
  [/\btwo[- ]person\b/g, " person lift "],
  [/\bout[- ]of[- ]level\b/g, " level out "],
  [/\bdrain[- ]side\b/g, " drain side "],
  [/\bweep ?holes?\b/g, " weep hole "],
  [/\bwhich way\b/g, " face side "],
  [/\bfaces? out\b/g, " face out "],
];

/** Apply the phrase rewrites. Exported so the tests can show what they do. */
export function rewritePhrases(text: string): string {
  let out = text.toLowerCase().replace(/[×✕]/g, "x");
  for (const [pattern, replacement] of PHRASES) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Ways installers say the same thing. Every word in a group folds onto the
 * group's first word, in both the question and the indexed content, so either
 * spelling finds the other. Kept deliberately small — merging too much makes
 * every word match everything.
 */
const SYNONYM_GROUPS: string[][] = [
  ["drain", "drains", "drainage", "weep", "weeps", "weephole", "weepholes"],
  ["sealant", "caulk", "caulking", "caulked", "sealer", "silicone", "urethane", "polyurethane"],
  ["bind", "binds", "binding", "drag", "drags", "dragging", "sticks", "sticking", "jams", "jamming"],
  ["person", "people", "man", "men", "guy", "guys", "helper", "bodies", "crew"],
  ["weight", "heavy", "heavier", "weigh", "weighs", "lb", "lbs", "pound", "pounds",
    "lift", "lifts", "lifting"],
  ["torque", "tight", "tighter", "tighten", "tightness", "tension", "inlb", "ftlb"],
  ["depth", "deep", "deeper", "setback", "setout", "recess", "recessed"],
  ["center", "centre", "centered", "centred", "middle"],
  ["order", "sequence", "sequencing", "lap", "laps"],
  ["clearance", "room", "swing"],
  ["brace", "bracing", "braced", "support", "supports", "bracket", "brackets", "shoring"],
  ["aluminum", "aluminium", "alum"],
  ["reuse", "reused", "reusing", "use", "uses", "using", "used", "salvage", "salvaged",
    "existing", "old"],
  ["rock", "stone", "veneer", "masonry"],
  ["stucco", "plaster"],
  ["glass", "lite", "lites", "pane", "panes", "glazing", "glazed"],
  ["tempered", "temper", "toughened"],
  ["screw", "screws", "fastener", "fasteners", "fasten", "fastening", "fastened"],
  ["shim", "shims", "shimming", "shimmed"],
  ["rain", "raining", "rainy", "storm", "downpour"],
  ["concrete", "cement", "slab"],
  ["roller", "rollers", "sheave", "sheaves", "wheel", "wheels"],
  ["hinge", "hinges", "pivot", "pivots"],
  ["slider", "sliders", "sliding", "slide", "slides"],
  ["casement", "crank", "cranks"],
  ["picture", "fixed", "stationary", "pic"],
  ["difficulty", "difficult", "hard", "harder", "rating", "rate"],
  ["duration", "long", "minutes", "hours", "takes", "take", "time", "timing"],
  ["tip", "tips", "advice", "pointer", "pointers", "trick", "tricks", "guidance"],
  ["watchout", "watch", "gotcha", "mistake", "mistakes", "careful", "wrong", "problem"],
  ["corner", "corners", "diagonal", "diagonals"],
  ["square", "squared", "squaring", "racked", "racking", "rack"],
  ["face", "faces", "facing", "faced", "outward", "outwards"],
  ["install", "installs", "installing", "installed", "installation", "set", "sets", "setting"],
];

/**
 * Cheap stemmer: enough to tie "flashing"/"flash", "bracing"/"brace",
 * "setting"/"set" and "holes"/"hole" together without pulling in a real
 * stemming library for 300 entries.
 */
export function stem(word: string): string {
  let w = word;
  let stripped = false;
  for (const suffix of ["ing", "ed"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length);
      stripped = true;
      break;
    }
  }
  if (!stripped && w.endsWith("s") && !w.endsWith("ss") && w.length > 3) {
    w = w.slice(0, -1);
    if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
    stripped = true;
  }
  // "setting" → "sett" → "set"; only after a suffix came off, so "glass" survives.
  if (stripped && w.length > 3 && w[w.length - 1] === w[w.length - 2]) w = w.slice(0, -1);
  if (w.endsWith("e") && w.length > 3) w = w.slice(0, -1);
  return w;
}

const SYNONYM_BY_STEM = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const canonical = stem(group[0]);
  for (const word of group) SYNONYM_BY_STEM.set(stem(word), canonical);
}

/** One word, folded to the form both the question and the content are indexed in. */
export function normalizeWord(word: string): string {
  const s = stem(word.toLowerCase());
  return SYNONYM_BY_STEM.get(s) ?? s;
}

/**
 * Split text into indexable words. Sizes are kept whole *and* split, so
 * "72x48" finds "Slider 72x48" and a question about a 48" opening finds it too.
 */
export function tokenize(text: string): string[] {
  const raw = rewritePhrases(text).split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[] = [];
  for (const piece of raw) {
    const size = piece.match(/^(\d{1,3})x(\d{1,3})$/);
    if (size) {
      out.push(piece, size[1], size[2]);
      continue;
    }
    out.push(piece);
  }
  return out
    .filter((w) => !STOPWORDS.has(w))
    .map(normalizeWord)
    .filter((w) => w.length > 1);
}

/** Adjacent word pairs. "weep hole", "sill pan" and "pressure plate" mean much
 * more together than apart, so a matching pair scores extra. */
export function bigrams(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

/** Distinct words, order preserved — what the scorer iterates over. */
export function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

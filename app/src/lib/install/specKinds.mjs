// What KIND of unit a mark spec describes: window or door, and — for a door —
// which door. Wave X of the transcripts program (X1/X2).
//
// WHY THIS FILE IS PLAIN JAVASCRIPT, next to a TypeScript module that
// re-exports it: the same rules have to run in two places. The app writes
// `project_mark_specs.unit_kind` / `.door_kind` at every specs write path, and
// `scripts/seed-spec-kinds.mjs` fills those columns in for every mark that
// already existed. A backfill that classified rows slightly differently from
// the app would be worse than no backfill at all — the card would say one thing
// today and another after the next re-extraction. So there is ONE function, in
// a file node can run and the bundler can bundle, and `unitKind.ts` re-exports
// it so nothing in the app imports a different path than it used to.
//
// IF YOU CHANGE THESE RULES, RERUN THE BACKFILL (Actions → "Run seed script" →
// spec-kinds, dry-run then apply). The stored columns are a photograph of what
// this file said on the day each row was written; edit the rules and the old
// photographs are stale until the seed re-takes them.
//
// The vocabulary is `docs/window-vendor-conventions.md` ("Reading vendor
// paperwork" and "Door kinds"), and the reading order deliberately mirrors
// `inferHardware` (app/src/lib/fitview/adapter.ts), which draws the same
// spec text: CLAUDE.md's law is that the two agree, so change them together.

/**
 * @typedef {"slider" | "french" | "bifold" | "swing" | "other"} DoorKind
 * @typedef {"window" | "door"} UnitKind
 */

// Whole words only, singular or plural. The boundaries matter: "outdoor living"
// and "indoor" must not turn a window into a door.
const DOOR_WORD = /\bdoors?\b/i;
const WINDOW_WORD = /\bwindows?\b/i;

/**
 * Window or door from a spec description, or null when the words aren't there.
 *
 * Door wins when a description says both, which is common and deliberate:
 * "French Door with Thermal break Fixed Window" is one door unit with a fixed
 * light beside it (six of Black Desert's marks read like this). A crew hangs
 * that as a door, so it is a door.
 *
 * Null means "this description doesn't say" — for a caller to fall back on,
 * rather than a guess dressed up as an answer.
 *
 * @param {string | null | undefined} description
 * @returns {UnitKind | null}
 */
export function unitKindFromDescription(description) {
  if (!description) return null;
  if (DOOR_WORD.test(description)) return "door";
  if (WINDOW_WORD.test(description)) return "window";
  return null;
}

/**
 * The words that name a door kind, in no particular order — POSITION in the
 * sentence is what ranks them, below. Each pattern is the vendor's own word:
 *
 *   french  "French Door", "French door track(Inward opening)"  — 3-point lock
 *   bifold  "Bi-Fold", "Bifold", "bi fold"                      — folding leaves
 *   slider  "Sliding Door", "slider", "patio door"              — panels slide
 *   swing   "Swing door", "hinged", "pivot"                     — leaves swing
 */
const DOOR_KIND_WORDS = [
  [/\bfrench\b/i, "french"],
  [/\bbi[\s-]?fold(ing)?\b/i, "bifold"],
  [/\b(slid\w*|patio)\b/i, "slider"],
  [/\b(swing\w*|hinged?|pivot\w*)\b/i, "swing"],
];

/**
 * The FIRST door word in a sentence, or null when it says none.
 *
 * Position decides because the supplier writes the unit first and its
 * neighbours after: Black Desert's mark #29 reads "3 Track 3 Panel Thermal
 * break Aluminum Sliding Door with Thermal break Aluminum French Door(Sliding
 * door 90 Corner meet)" — a slider that ends in a French door, and a slider is
 * what a crew hangs. Mark #31 reads "French Door with Thermal break Fixed
 * Window" the same way round and is a French door.
 *
 * @param {string} text
 * @returns {DoorKind | null}
 */
function firstDoorWord(text) {
  /** @type {DoorKind | null} */
  let found = null;
  let at = Infinity;
  for (const [pattern, kind] of DOOR_KIND_WORDS) {
    const m = pattern.exec(text);
    if (m && m.index < at) {
      at = m.index;
      found = /** @type {DoorKind} */ (kind);
    }
  }
  return found;
}

/**
 * Which door is this? Style text wins, exactly as `unitKindFromDescription`
 * believes the supplier's sentence over anything we derived — and exactly as
 * `inferHardware` reads `styleText` before it reads the operation letters.
 *
 * Order:
 *  1. the style line's own door word (Black Desert's #26-#39, Mad Moose's
 *     French and commercial doors all name themselves here);
 *  2. the operation line's door word, for the marks whose style says only
 *     "Commercial style door" and whose operation says "Swing door, single
 *     leaf" (Mad Moose, live pilot 2026-09-02);
 *  3. the operation LETTERS, read from outside, X = operating, O = fixed. Only
 *     "OXXO" is a door kind on its own — that is the four-panel two-track
 *     slider the vendor doc names, and the one letter string `inferHardware`
 *     turns into slider language (`bipart`) without help from the style. Every
 *     other letter string it draws as a hinged leaf, so a hinged leaf is what
 *     this calls it. Letters never override a word: Mad Moose's French doors
 *     drew as sliders once (units.ts) and that is the bug this ordering avoids.
 *  4. otherwise "other" — a door whose paperwork does not say which. Honest,
 *     and countable, which is the whole point of storing it.
 *
 * PURE.
 *
 * @param {string | null | undefined} style
 * @param {string | null | undefined} operation
 * @returns {DoorKind}
 */
export function doorKind(style, operation) {
  const fromStyle = firstDoorWord(style ?? "");
  if (fromStyle) return fromStyle;

  const fromOperation = firstDoorWord(operation ?? "");
  if (fromOperation) return fromOperation;

  const letters = (operation ?? "").trim().toUpperCase();
  if (/^[XO]{2,}$/.test(letters)) return letters === "OXXO" ? "slider" : "swing";

  return "other";
}

/**
 * @typedef {object} SpecKindInput
 * @property {string | null | undefined} [style]
 * @property {string | null | undefined} [operation]
 */

/**
 * @typedef {object} SpecKindColumns
 * @property {UnitKind | null} unit_kind
 * @property {DoorKind | null} door_kind
 */

/**
 * The two stored columns for one mark spec — the single classifier every write
 * path calls, so a mark reads the same whether it arrived from extraction, a
 * foreman's edit, Studio, or the backfill.
 *
 * `door_kind` is null for anything that is not a door, and null `unit_kind`
 * means the paperwork does not say: the counts view keeps those in their own
 * "unknown" bucket rather than guessing them into the window pile.
 *
 * @param {SpecKindInput} spec
 * @returns {SpecKindColumns}
 */
export function specKindColumns(spec) {
  const unit =
    unitKindFromDescription(spec?.style) ??
    unitKindFromDescription(spec?.operation);
  return {
    unit_kind: unit,
    door_kind: unit === "door" ? doorKind(spec?.style, spec?.operation) : null,
  };
}

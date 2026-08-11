// Which story does this plan sheet show? Read the title and say — or say
// "unclear" and mean it.
//
// Grounded in the drafting-convention research behind
// docs/maps-interactive-stories-design.md: the sheet TITLE is the strong
// story signal in US plan sets ("SECOND FLOOR PLAN", "LEVEL 3", "UPPER
// LEVEL"), the sheet NUMBER is only a cross-check, and a title is one signal
// — so nothing detected here ever claims better than "probable". The
// governing rule stands: two independent signals = confirmed, one =
// probable, conflict or none = unclear, never silently pick.
//
// Everything is pure and string-in/string-out so the grammar is testable
// against the research's catalogue of real-world phrasings.

export interface SheetStoryReading {
  /** 1-based story when the title names exactly one. */
  story?: number;
  /** Inclusive story range for typical-floor sheets ("LEVELS 2-6"). */
  range?: [number, number];
  /** Relative word pending resolution against the whole set. */
  relative?: "main" | "upper" | "lower" | "basement";
  /** The matched title text, verbatim — the evidence a human reads. */
  evidence: string;
}

const ORDINALS: Record<string, number> = {
  FIRST: 1, "1ST": 1, SECOND: 2, "2ND": 2, THIRD: 3, "3RD": 3,
  FOURTH: 4, "4TH": 4, FIFTH: 5, "5TH": 5, SIXTH: 6, "6TH": 6,
  SEVENTH: 7, "7TH": 7, EIGHTH: 8, "8TH": 8,
};

/**
 * Sheets that repeat a story's name but must never source window instances:
 * demolition, existing-conditions, consultant overlays, reflected ceilings,
 * framing, foundations (no windows), roofs (skylights live elsewhere).
 */
const REJECT =
  /\b(DEMO(LITION)?|EXISTING|ELECTRICAL|MECHANICAL|PLUMBING|HVAC|CEILING|RCP|FRAMING|FOUNDATION|FOOTING|ROOF|SITE|LANDSCAPE|GRADING)\b/;

/**
 * Read one line of sheet text as a story-bearing plan title. Returns null
 * for lines that say nothing about stories; a reading for the ones that do.
 * Callers feed every extracted line of a page and keep the first reading.
 */
export function parseSheetTitle(line: string): SheetStoryReading | null {
  const t = line.toUpperCase().replace(/\s+/g, " ").trim();
  if (!t || REJECT.test(t)) return null;

  // "LEVELS 2-6", "LEVELS 2 THRU 6", "2ND-6TH FLOOR" — typical-floor ranges.
  const range =
    /\bLEVELS?\s+(\d{1,2})\s*(?:-|–|TO|THRU|THROUGH)\s*(\d{1,2})\b/.exec(t);
  if (range && /\b(PLAN|LEVEL)/.test(t)) {
    const a = parseInt(range[1], 10);
    const b = parseInt(range[2], 10);
    if (a >= 1 && b > a && b <= 40) return { range: [a, b], evidence: line.trim() };
  }

  // Needs to look like a floor-plan title at all.
  const planish = /\b(FLOOR|LEVEL)\b/.test(t) && /\bPLAN\b/.test(t);
  const bareLevel = /\bLEVEL\s+\d{1,2}\b/.test(t);
  if (!planish && !bareLevel) return null;

  // "LEVEL 3", "LEVEL 3 FLOOR PLAN", "PLAN - LEVEL 2" (Revit-era sets).
  const lvl = /\bLEVEL\s+(\d{1,2})\b/.exec(t);
  if (lvl) {
    const n = parseInt(lvl[1], 10);
    if (n >= 1 && n <= 40) return { story: n, evidence: line.trim() };
  }

  // "SECOND FLOOR PLAN", "2ND FLOOR PLAN"…
  for (const word of Object.keys(ORDINALS)) {
    if (new RegExp("\\b" + word + "\\b").test(t)) {
      return { story: ORDINALS[word], evidence: line.trim() };
    }
  }

  // Relative words: meaning depends on the whole set (research: MAIN is
  // ground on most plans and the middle of a split-level).
  if (/\bGROUND\b/.test(t)) return { story: 1, evidence: line.trim() };
  if (/\bMAIN\b/.test(t)) return { relative: "main", evidence: line.trim() };
  if (/\bUPPER\b/.test(t)) return { relative: "upper", evidence: line.trim() };
  if (/\bLOWER\b/.test(t)) return { relative: "lower", evidence: line.trim() };
  if (/\bBASEMENT\b/.test(t)) return { relative: "basement", evidence: line.trim() };

  return null;
}

export interface PageStory {
  pageNumber: number;
  /** 1-based story this page shows; absent = detected but unresolved. */
  story?: number;
  /** Set when this page stands for a whole run of stories ("LEVELS 2-6"):
   *  the page maps to EVERY story in the range, and windows tagged on it
   *  expand into per-story clones. */
  range?: [number, number];
  name: string;
  /** Always "probable": a title is ONE signal. */
  confidence: "probable";
  evidence: string;
}

export interface StoryDetection {
  /** Pages that read as story-bearing plan sheets, resolved. */
  pages: PageStory[];
  /** Distinct stories seen, ascending — the skeleton of a story list. */
  stories: { n: number; name: string; evidence: string }[];
  /** Pages whose titles say something story-ish that could NOT be resolved
   *  (splits, basements, bare ranges) — the honest leftovers. */
  unresolved: { pageNumber: number; reason: string; evidence: string }[];
}

const STORY_NAMES = ["Ground", "Level 2", "Level 3", "Level 4", "Level 5", "Level 6", "Level 7", "Level 8"];

/**
 * Resolve every page's reading against the whole set. Relative words get
 * their standard meanings only when the set supports them: {MAIN, UPPER} →
 * 1, 2; a set with LOWER present is a split-level and stays unresolved
 * (research: ordinals are ill-defined there — a human names those levels).
 */
export function detectPageStories(
  pages: { pageNumber: number; lines: string[] }[],
): StoryDetection {
  const readings: { pageNumber: number; r: SheetStoryReading }[] = [];
  for (const p of pages) {
    for (const line of p.lines) {
      const r = parseSheetTitle(line);
      if (r) {
        readings.push({ pageNumber: p.pageNumber, r });
        break; // first story-bearing title wins for a page
      }
    }
  }

  const hasLower = readings.some(({ r }) => r.relative === "lower" || r.relative === "basement");
  const out: StoryDetection = { pages: [], stories: [], unresolved: [] };
  const seen = new Map<number, { name: string; evidence: string }>();

  for (const { pageNumber, r } of readings) {
    if (r.range) {
      // Phase 3: a typical-floor sheet stands for every story in its range.
      // The drawings assert near-identity, not identity, so everything born
      // from a range stays "probable" and says which sheet it came from.
      const [a, b] = r.range;
      if (b > 8) {
        out.unresolved.push({
          pageNumber,
          reason: `range ${a}–${b} passes the 8-story ceiling`,
          evidence: r.evidence,
        });
        continue;
      }
      out.pages.push({
        pageNumber, story: a, range: [a, b],
        name: STORY_NAMES[a - 1] ?? `Level ${a}`,
        confidence: "probable", evidence: r.evidence,
      });
      for (let n = a; n <= b; n++) {
        if (!seen.has(n)) {
          seen.set(n, { name: STORY_NAMES[n - 1] ?? `Level ${n}`, evidence: r.evidence });
        }
      }
      continue;
    }
    let story = r.story;
    if (r.relative) {
      if (hasLower) {
        out.unresolved.push({
          pageNumber,
          reason: "split-level naming (LOWER/BASEMENT present) — name these levels by hand",
          evidence: r.evidence,
        });
        continue;
      }
      if (r.relative === "main") story = 1;
      else if (r.relative === "upper") story = 2;
    }
    if (!story || story < 1 || story > 8) {
      out.unresolved.push({
        pageNumber,
        reason: story ? `story ${story} is past the 8-story ceiling` : "unreadable story",
        evidence: r.evidence,
      });
      continue;
    }
    const name = STORY_NAMES[story - 1] ?? `Level ${story}`;
    out.pages.push({ pageNumber, story, name, confidence: "probable", evidence: r.evidence });
    if (!seen.has(story)) seen.set(story, { name, evidence: r.evidence });
  }

  out.stories = [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, v]) => ({ n, name: v.name, evidence: v.evidence }));
  return out;
}


/**
 * H3 — marks that encode their floor ("201", "W-301", "3W12"): the leading
 * digit(s) name the story. The research's hard rule: many sets number by
 * TYPE, not floor, so the pattern is only believed after it is VALIDATED
 * against marks whose story is already known from sheet titles, with zero
 * contradictions and at least three agreements. A validated prefix is a
 * genuinely independent second signal — and two agreeing signals is what
 * "confirmed" means.
 */
export function markPrefixStory(code: string): number | null {
  const t = code.trim().toUpperCase();
  const m = /^(?:[A-Z]{1,2}-?)?([1-8])\d{2}$/.exec(t);
  return m ? parseInt(m[1], 10) : null;
}

export function validateMarkPrefixes(
  marks: { code: string; titleStory?: number }[],
): { trusted: boolean; agreements: number; contradictions: number } {
  let agreements = 0;
  let contradictions = 0;
  for (const m of marks) {
    const pre = markPrefixStory(m.code);
    if (pre == null || m.titleStory == null) continue;
    if (pre === m.titleStory) agreements++;
    else contradictions++;
  }
  return { trusted: contradictions === 0 && agreements >= 3, agreements, contradictions };
}

/**
 * The sheet's declared scale ("1/4" = 1'-0"", "SCALE: 1/8"=1'-0"", "1:50").
 * With the page's paper size known from the PDF, this makes manual
 * calibration OPTIONAL: the drawing already says how big it is. Returns real
 * metres per paper inch, plus the matched text as evidence.
 */
export function parseScaleNote(
  lines: string[],
): { metresPerPaperInch: number; evidence: string } | null {
  for (const line of lines) {
    const t = line.toUpperCase().replace(/\s+/g, " ").trim();
    // 1/4" = 1'-0"  (paper fraction of an inch = one real foot)
    const imp = /(\d+)\s*\/\s*(\d+)\s*(?:"|IN(?:CH)?)?\s*=\s*1\s*'/.exec(t);
    if (imp) {
      const num = parseInt(imp[1], 10);
      const den = parseInt(imp[2], 10);
      if (num > 0 && den > 0 && num / den <= 3) {
        // (den/num) real feet per paper inch.
        return { metresPerPaperInch: (den / num) * 0.3048, evidence: line.trim() };
      }
    }
    // Metric 1:50, 1:100 — one paper unit = N real units.
    const met = /\b1\s*:\s*(\d{2,3})\b/.exec(t);
    if (met && /SCALE/.test(t)) {
      const ratio = parseInt(met[1], 10);
      if (ratio >= 20 && ratio <= 500) {
        return { metresPerPaperInch: ratio * 0.0254, evidence: line.trim() };
      }
    }
  }
  return null;
}

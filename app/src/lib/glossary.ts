// Commercial window & door glossary + Leitner spaced-repetition.
// Terms ported from the Infinity "learn-data.js" content.

export interface GlossaryCat {
  id: string;
  label: string;
}

export interface Term {
  id: string;
  cat: string;
  term: string;
  desc: string;
}

export const CATS: GlossaryCat[] = [
  { id: "frame", label: "Frame & Materials" },
  { id: "glazing", label: "Glazing" },
  { id: "sealing", label: "Sealing & Flashing" },
  { id: "opening", label: "Openings & Structure" },
  { id: "hardware", label: "Hardware & Operation" },
  { id: "systems", label: "Commercial Systems" },
  { id: "install", label: "Installation Methods" },
  { id: "codes", label: "Codes, Specs & Safety" },
];

export const TERMS: Term[] = [
  // Frame & Materials
  { id: "frame", cat: "frame", term: "Frame", desc: "The fixed perimeter assembly (head, jambs, sill) that carries the glass or panel and transfers loads into the wall. If it goes in twisted or bowed, nothing hung in it runs right." },
  { id: "jamb", cat: "frame", term: "Jamb", desc: "The vertical side member. Over-shimming a jamb bows it inward, binding sashes and cracking glass — two snug shim points per side on aluminum." },
  { id: "head", cat: "frame", term: "Head", desc: "The top horizontal member. It must never carry structural load — flash the head last so laps shed water." },
  { id: "sill", cat: "frame", term: "Sill", desc: "The bottom member and most water-critical part. Must be dead level and sit over a sill pan so trapped water drains out, not in." },
  { id: "mullion", cat: "frame", term: "Mullion", desc: "A member joining two units or dividing a frame into bays. Structural mullions carry wind load and often need steel reinforcement — verify against shop drawings." },
  { id: "sash", cat: "frame", term: "Sash", desc: "The operable framed panel that holds the glass. A dragging sash almost always means a sill or frame problem, not a sash problem." },
  { id: "thermalbreak", cat: "frame", term: "Thermal Break", desc: "A low-conductivity barrier separating interior and exterior halves of an aluminum extrusion. Never bridge it with the wrong fasteners." },
  { id: "extrusion", cat: "frame", term: "Extrusion", desc: "An aluminum profile pushed through a die. Strong along its length but easy to crush across the section — mind shim and clamp pressure." },
  { id: "weep", cat: "frame", term: "Weep Hole", desc: "A slotted opening that drains water out of the frame. Blocking weeps with sealant is one of the most damaging field mistakes." },
  { id: "flange", cat: "frame", term: "Nailing Flange / Fin", desc: "The perimeter fin that laps the sheathing and takes fasteners and flashing tape. A cracked flange breaks the water seal — straighten or reject." },

  // Glazing
  { id: "igu", cat: "glazing", term: "IGU (Insulated Glass Unit)", desc: "Two+ lites sealed around a spacer to trap an insulating airspace. Twisting the unit or skipping setting blocks breaks the edge seal and fogs the glass." },
  { id: "lowe", cat: "glazing", term: "Low-E Coating", desc: "A thin metallic coating that reflects heat while passing light. Installing a lite backwards flips the building's energy behavior — check the coating surface." },
  { id: "argon", cat: "glazing", term: "Argon Fill", desc: "Inert gas sealed in the airspace to slow heat transfer. Sudden interior condensation usually means the seal and the argon are gone." },
  { id: "tempered", cat: "glazing", term: "Tempered Glass", desc: "Heat-treated, ~4x stronger, shatters into cubes. Required in doors/sidelites/near-floor. Can't be cut after treatment — wrong size is a reorder. Look for the etched bug." },
  { id: "laminated", cat: "glazing", term: "Laminated Glass", desc: "Two lites bonded to a plastic interlayer — cracks but stays in frame. Heavier per sq ft, so recalc crew and lifting gear before it shows up." },
  { id: "setblock", cat: "glazing", term: "Setting Block", desc: "Hard rubber blocks at the quarter points that carry the glass weight into the frame. Missing/mislocated blocks are a classic cause of 'mystery' cracks." },

  // Sealing & Flashing
  { id: "sillpan", cat: "sealing", term: "Sill Pan", desc: "A waterproof pan under the sill that catches and drains any water that gets past the seal. Back-dam and end-dams must be continuous." },
  { id: "flashtape", cat: "sealing", term: "Flashing Tape", desc: "Self-adhered membrane lapping the flange to the WRB. Shingle-lap it (bottom first, head last) so water always sheds over, never under." },
  { id: "backerrod", cat: "sealing", term: "Backer Rod", desc: "Foam rod set into a joint before sealant to control depth and give the bead an hourglass shape — sealant should bond two sides, not three." },

  // Openings & Structure
  { id: "ro", cat: "opening", term: "Rough Opening", desc: "The framed hole the unit sets into — sized larger than the unit for shim clearance. Measure width at 3 points, height at 2, and use the smallest." },
  { id: "header", cat: "opening", term: "Header", desc: "The structural beam over the opening that carries load around it. A sagging header landing on the frame head will rack the unit." },
  { id: "shim", cat: "opening", term: "Shim", desc: "Tapered spacers that plumb, level and square the unit in the opening. Shim at fastener points so tightening doesn't bow the frame." },

  // Hardware & Operation
  { id: "balance", cat: "hardware", term: "Balance", desc: "The spring mechanism that holds a hung sash at any height. A sash that won't stay up has a failed or mismatched balance." },
  { id: "roller", cat: "hardware", term: "Roller", desc: "The wheel a slider sash rides on. Adjust rollers to lift a dragging sash — but first confirm the sill is level." },

  // Commercial Systems
  { id: "storefront", cat: "systems", term: "Storefront", desc: "Non-load-bearing aluminum-and-glass system for ground floors, typically center-glazed and shop-fabricated in stick form on site." },
  { id: "curtainwall", cat: "systems", term: "Curtain Wall", desc: "A building-height aluminum framing system hung off the structure that carries only its own weight and wind — not floor loads." },

  // Installation Methods
  { id: "drylazing", cat: "install", term: "Dry Glazing", desc: "Glass retained by preformed gaskets rather than wet sealant — faster and cleaner, but gaskets must be continuous and corners sealed." },
  { id: "plumbsquare", cat: "install", term: "Plumb, Level & Square", desc: "The three checks on every unit before fastening: sides plumb, sill level, diagonals equal. Set it wrong and every operation binds." },

  // Codes, Specs & Safety
  { id: "dp", cat: "codes", term: "DP Rating", desc: "Design Pressure — the wind load a unit is rated to resist. Never install a lower-DP unit than the spec calls for." },
  { id: "egress", cat: "codes", term: "Egress", desc: "A window sized as a legal emergency exit (min clear opening + sill height). Bedrooms usually require one — don't block it with a fixed unit." },
];

export type Grade = "again" | "got";

// Leitner intervals per box, in days.
const INTERVALS = [0, 1, 2, 4, 9, 21];

export function nextBox(box: number, grade: Grade): number {
  if (grade === "again") return 0;
  return Math.min(INTERVALS.length - 1, box + 1);
}

export function dueDateFor(box: number, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + INTERVALS[Math.min(box, INTERVALS.length - 1)]);
  return d.toISOString().slice(0, 10);
}

export interface CardProgress {
  term_id: string;
  box: number;
  due: string; // yyyy-mm-dd
}

/** Build today's deck: priority terms first, then due cards, then new. */
export function buildDeck(
  progress: CardProgress[],
  priorityIds: string[],
  limit = 5,
  today = new Date().toISOString().slice(0, 10),
): Term[] {
  const byId = new Map(progress.map((p) => [p.term_id, p]));
  const priority = new Set(priorityIds);
  const scored = TERMS.map((t) => {
    const p = byId.get(t.id);
    const isNew = !p;
    const isDue = p ? p.due <= today : true;
    // Priority terms always qualify (rank 0); then new, then due; else excluded.
    const rank = priority.has(t.id) ? 0 : isNew ? 2 : isDue ? 3 : 999;
    return { t, rank, due: p?.due ?? "0000" };
  })
    .filter((x) => x.rank < 999)
    .sort((a, b) => a.rank - b.rank || a.due.localeCompare(b.due));
  return scored.slice(0, limit).map((x) => x.t);
}

/** Knowledge score 0-100: how far through the boxes the whole glossary is. */
export function knowledgeScore(progress: CardProgress[]): number {
  if (TERMS.length === 0) return 0;
  const byId = new Map(progress.map((p) => [p.term_id, p]));
  const total = TERMS.reduce((s, t) => s + (byId.get(t.id)?.box ?? 0), 0);
  const max = TERMS.length * (INTERVALS.length - 1);
  return Math.round((total / max) * 100);
}

/** 4-option multiple-choice question from a term (distractors same category). */
export function quizQuestion(term: Term): { prompt: string; options: Term[]; answer: Term } {
  const sameCat = TERMS.filter((t) => t.cat === term.cat && t.id !== term.id);
  const pool = (sameCat.length >= 3 ? sameCat : TERMS.filter((t) => t.id !== term.id));
  const distractors = [...pool].sort(() => Math.random() - 0.5).slice(0, 3);
  const options = [term, ...distractors].sort(() => Math.random() - 0.5);
  return { prompt: term.desc, options, answer: term };
}

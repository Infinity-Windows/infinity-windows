// Cross-reference the specs sheet against the building plans and say, in plain
// English, what doesn't add up.
//
// WHY THIS EXISTS. A planset from a supplier is not a contract, it's a document
// typed by a human, and the two documents on a job disagree more often than
// anyone would like. On the real Black Desert job the building plans call out 38
// distinct marks and the supplier's spec sheet covers 37 — but they are not the
// same 37. The sheet's own panel numbers run #1…#39 and simply SKIP #7 and #8
// (verified against the PDF: page 2's four panels are labelled #5, #6, #9, #10),
// while the sheet carries a #25 that no opening on the plans asks for — an
// interior French door whose drawing panel the supplier left blank, which is why
// it has no dimensions either.
//
// None of that was visible in the app. The extraction reported every page `ok`,
// the review screen showed 37 healthy-looking rows, and an installer who opened
// mark #7 just got a blank space that read like a broken app.
//
// So the check has to run in BOTH directions and be automatic. This module is
// the pure half: given the marks on the plans, the specs that were extracted,
// and whatever a foreman has already labelled as a known supplier gap, it
// returns the list of things that don't reconcile and the sentences to say about
// them. No DB, no network, no React — so it can be unit-tested against the real
// Black Desert and Smith numbers rather than eyeballed.
//
// It deliberately builds on `computeSpecCoverage` rather than re-deriving the
// mark buckets: that function already knows how to compare a mark that appears
// as "14-18" on an opening with a mark that appears as "18" on a spec, and how
// to tell a spec row with real content from one that recognised the mark and
// nothing else.

import {
  compareMarks,
  computeSpecCoverage,
  type CoverageSpec,
} from "./specCoverage";
import { markBase } from "./extract";
import { unitKindFromDescription } from "./unitKind";

/**
 * The four ways the two documents can fail to agree.
 *
 * `mark_without_spec` and `spec_without_mark` are the two directions the user
 * asked for. `spec_without_size` and `spec_without_drawing` are the "the row is
 * there but it's half a spec" cases — a crew can't cut an opening from a style
 * string alone.
 */
export type DiscrepancyKind =
  | "mark_without_spec"
  | "spec_without_mark"
  | "spec_without_size"
  | "spec_without_drawing";

/** The order the report speaks in: most blocking first. */
const KIND_ORDER: DiscrepancyKind[] = [
  "mark_without_spec",
  "spec_without_mark",
  "spec_without_size",
  "spec_without_drawing",
];

/** A mark the building plans ask for, and how much of it. */
export interface PlanMark {
  /** Base mark, e.g. "7", "18B". */
  mark: string;
  /** How many openings on the plans carry this mark. */
  units: number;
  /** True only when the plans actually classify it as a door. */
  isDoor?: boolean;
}

/** A spec row, plus the fields reconciliation needs beyond coverage. */
export interface ReconcileSpec extends CoverageSpec {
  style?: string | null;
}

/**
 * A foreman's label on one discrepancy: "yes, we know, we're chasing it."
 * Keyed by mark + kind so acknowledging "#7 has no spec" doesn't also silence
 * "#7's spec has no size" if a thin spec later appears.
 */
export interface DiscrepancyAck {
  mark_code: string;
  kind: DiscrepancyKind;
  note?: string | null;
}

/** One thing that doesn't add up between the two documents. */
export interface Discrepancy {
  /** Canonical (upper-cased) base mark. */
  mark: string;
  kind: DiscrepancyKind;
  /** Openings on the plans with this mark; 0 for a spec nobody asked for. */
  units: number;
  /** True only when the plans say door. Absence means "window, or unknown". */
  isDoor: boolean;
  /** Style off the spec sheet, when a spec row exists. */
  style: string | null;
  /** False when the spec row carries no width, height, or call size at all. */
  hasSize: boolean;
  /** A human has labelled this a known supplier gap. */
  acknowledged: boolean;
  /** What they said about it, if anything. */
  note: string | null;
}

export interface Reconciliation {
  /** Distinct marks the building plans ask for. */
  planMarkCount: number;
  /** Distinct marks the spec sheet covers. */
  specMarkCount: number;
  /** Everything that doesn't add up, acknowledged or not. */
  discrepancies: Discrepancy[];
  /** Not yet labelled — this is what the report shouts about. */
  open: Discrepancy[];
  /** Labelled as a known supplier gap being chased. */
  acknowledged: Discrepancy[];
  /** True when the two documents agree completely. */
  reconciled: boolean;
}

/** Canonical comparison key for a mark or opening code. */
function key(code: string | null | undefined): string | null {
  if (code == null) return null;
  const trimmed = markBase(String(code)).trim().toUpperCase();
  return trimmed ? trimmed : null;
}

/** True when a spec row carries a size a crew could cut an opening to. */
export function specHasSize(spec: ReconcileSpec): boolean {
  return (
    spec.width_in != null ||
    spec.height_in != null ||
    (typeof spec.size_code === "string" && spec.size_code.trim().length > 0)
  );
}

/**
 * Collapse a project's openings into the distinct marks its plans ask for, with
 * a unit count and whether the plans call it a door. PURE.
 *
 * A mark is a door only if the plans say so on at least one of its openings —
 * an auto-created placeholder window type (which is what an extraction leaves
 * behind when it recognises a mark but nothing else) categorises everything as
 * a window, so the door flag is treated as evidence when present and never as
 * evidence of the opposite.
 */
export function planMarksFromOpenings(
  openings: {
    opening_code: string | null | undefined;
    window_types?: { category?: string | null } | null;
  }[],
): PlanMark[] {
  const byMark = new Map<string, PlanMark>();
  for (const o of openings ?? []) {
    const k = key(o?.opening_code);
    if (!k) continue;
    const isDoor = (o?.window_types?.category ?? "")
      .toLowerCase()
      .includes("door");
    const existing = byMark.get(k);
    if (existing) {
      existing.units += 1;
      existing.isDoor = existing.isDoor || isDoor;
    } else {
      byMark.set(k, { mark: k, units: 1, isDoor });
    }
  }
  return [...byMark.values()].sort((a, b) => compareMarks(a.mark, b.mark));
}

/**
 * Cross-reference the plans against the specs and return everything that
 * doesn't add up. PURE.
 *
 * Rules, per mark:
 *   - on the plans, no usable spec row       → `mark_without_spec`
 *   - a spec row, no opening on the plans    → `spec_without_mark`
 *   - on the plans, spec row with no size    → `spec_without_size`
 *   - on the plans, spec row with no drawing → `spec_without_drawing`
 *
 * The two "half a spec" kinds only fire for marks that ARE on the plans. A spec
 * for a mark nobody asked for is already fully described by
 * `spec_without_mark`, and reporting its missing size as a second finding would
 * make one supplier oddity look like two problems — the missing size still
 * rides along on the discrepancy as `hasSize: false` so the report can mention
 * it in passing.
 *
 * A mark on the plans CAN raise both `spec_without_size` and
 * `spec_without_drawing`: those are two different things to go and get, and a
 * foreman may well chase one without the other.
 */
export function reconcileSpecsWithPlans(input: {
  planMarks: PlanMark[];
  specs: ReconcileSpec[];
  acknowledgements?: DiscrepancyAck[];
}): Reconciliation {
  const planMarks = input.planMarks ?? [];
  const specs = input.specs ?? [];

  const planByMark = new Map<string, PlanMark>();
  for (const p of planMarks) {
    const k = key(p?.mark);
    if (!k) continue;
    const existing = planByMark.get(k);
    if (existing) {
      existing.units += p.units;
      existing.isDoor = existing.isDoor || Boolean(p.isDoor);
    } else {
      planByMark.set(k, { mark: k, units: p.units, isDoor: Boolean(p.isDoor) });
    }
  }

  // Merge duplicate spec rows for a mark the same way coverage does: the more
  // complete row wins, so a thin duplicate can't mask a good spec.
  const specByMark = new Map<string, ReconcileSpec>();
  for (const s of specs) {
    const k = key(s?.mark_code);
    if (!k) continue;
    const existing = specByMark.get(k);
    if (!existing || (!specHasSize(existing) && specHasSize(s))) {
      specByMark.set(k, s);
    }
  }

  // Expand each plan mark back into opening codes so coverage sees the same
  // expected set, then let it do the bucketing it already knows how to do.
  const openingCodes = [...planByMark.keys()];
  const coverage = computeSpecCoverage(openingCodes, specs);

  const ackIndex = new Map<string, DiscrepancyAck>();
  for (const a of input.acknowledgements ?? []) {
    const k = key(a?.mark_code);
    if (!k || !a?.kind) continue;
    ackIndex.set(`${k}::${a.kind}`, a);
  }

  const make = (mark: string, kind: DiscrepancyKind): Discrepancy => {
    const plan = planByMark.get(mark);
    const spec = specByMark.get(mark);
    const ack = ackIndex.get(`${mark}::${kind}`);
    // The supplier's own description first, exactly as the map reads it, so
    // "#26 (door)" here and a door-coloured pin there are the same mark. The
    // plans only answer for a mark with no spec to read.
    const described = unitKindFromDescription(spec?.style);
    return {
      mark,
      kind,
      units: plan?.units ?? 0,
      isDoor: described ? described === "door" : Boolean(plan?.isDoor),
      style: spec?.style?.trim() ? spec.style.trim() : null,
      hasSize: spec ? specHasSize(spec) : false,
      acknowledged: Boolean(ack),
      note: ack?.note?.trim() ? ack.note.trim() : null,
    };
  };

  const found: Discrepancy[] = [];
  for (const mark of coverage.missingSpec) found.push(make(mark, "mark_without_spec"));
  for (const mark of coverage.unexpected) found.push(make(mark, "spec_without_mark"));
  for (const mark of [...coverage.ok, ...coverage.missingDrawing].sort(compareMarks)) {
    const spec = specByMark.get(mark);
    if (spec && !specHasSize(spec)) found.push(make(mark, "spec_without_size"));
  }
  for (const mark of coverage.missingDrawing) {
    found.push(make(mark, "spec_without_drawing"));
  }

  const discrepancies = found.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      compareMarks(a.mark, b.mark),
  );

  return {
    planMarkCount: planByMark.size,
    specMarkCount: specByMark.size,
    discrepancies,
    open: discrepancies.filter((d) => !d.acknowledged),
    acknowledged: discrepancies.filter((d) => d.acknowledged),
    reconciled: discrepancies.length === 0,
  };
}

/** "#7" / "#7 (door)" — the door note only when the plans actually say door. */
export function markLabel(d: Discrepancy): string {
  return d.isDoor ? `#${d.mark} (door)` : `#${d.mark}`;
}

/** "#7" / "#7 and #8" / "#7, #8 and #25". */
function joinMarks(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The sentence for one group of same-kind discrepancies, in the words a foreman
 * would use. No "coverage", no "gap", no "bidirectional" — the question being
 * answered is "what doesn't add up". PURE.
 */
export function describeGroup(kind: DiscrepancyKind, items: Discrepancy[]): string {
  const n = items.length;
  const marks = joinMarks(items.map(markLabel));
  switch (kind) {
    case "mark_without_spec":
      return n === 1
        ? `1 mark on the plans has no spec sheet: ${marks}.`
        : `${n} marks on the plans have no spec sheet: ${marks}.`;
    case "spec_without_mark": {
      // The Black Desert #25 case: worth saying it has no size either, because
      // that is the tell-tale of a panel the supplier left blank.
      const sizeless = items.filter((d) => !d.hasSize).length === n && n > 0;
      const tail = sizeless
        ? n === 1
          ? " — no size given either."
          : " — no sizes given either."
        : ".";
      return n === 1
        ? `1 spec has no window on the plans: ${marks}${tail}`
        : `${n} specs have no window on the plans: ${marks}${tail}`;
    }
    case "spec_without_size":
      return n === 1
        ? `1 spec has no size on it: ${marks}.`
        : `${n} specs have no size on them: ${marks}.`;
    case "spec_without_drawing":
      return n === 1
        ? `1 spec has no drawing: ${marks}.`
        : `${n} specs have no drawing: ${marks}.`;
  }
}

/** One sentence per kind, for the discrepancies passed in. PURE. */
export function reconciliationLines(
  discrepancies: Discrepancy[],
): { kind: DiscrepancyKind; text: string }[] {
  const out: { kind: DiscrepancyKind; text: string }[] = [];
  for (const kind of KIND_ORDER) {
    const items = discrepancies.filter((d) => d.kind === kind);
    if (items.length > 0) out.push({ kind, text: describeGroup(kind, items) });
  }
  return out;
}

/**
 * The whole report as one plain-language string, or NULL when the two documents
 * agree — a job where everything reconciles must say nothing at all rather than
 * congratulate itself. Acknowledged discrepancies are excluded: they've been
 * answered, and they're reported separately as work in progress. PURE.
 */
export function describeReconciliation(r: Reconciliation): string | null {
  if (r.open.length === 0) return null;
  return reconciliationLines(r.open)
    .map((l) => l.text)
    .join(" ");
}

/** "Being chased with the supplier: #7 and #8." — or null when none are. */
export function describeAcknowledged(r: Reconciliation): string | null {
  if (r.acknowledged.length === 0) return null;
  const marks = joinMarks(
    [...new Set(r.acknowledged.map((d) => `#${d.mark}`))].sort(compareMarks),
  );
  return `Being chased with the supplier: ${marks}.`;
}

/**
 * What an INSTALLER sees on a unit whose mark has no spec sheet. Calm and
 * non-alarming on purpose: supplier sheets skip marks all the time, the app is
 * working correctly, and the installer's job is to keep going — not to worry
 * that something is broken or to start phoning the supplier themselves. PURE.
 */
export function installerMissingSpecMessage(
  mark: string,
  acknowledged: boolean,
): string {
  const head = `No spec sheet for mark #${mark} — the supplier's sheet doesn't cover this one.`;
  return acknowledged
    ? `${head} The office knows and is chasing it.`
    : `${head} The office has been told.`;
}

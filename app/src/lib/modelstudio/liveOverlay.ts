// Studio live overlays (owner-approved recs #1,3,4,5,6,17,19): paint the
// SAME live signals the interactive map and the warehouse hub already show,
// onto whatever mark a modeled unit was placed or pulled under.
//
// Nothing here is a new rule. Every field is a straight read of an existing
// pure function — glowFor/flashFor (adapter.ts), blockedUnits (sessions.ts),
// unitParts/partsHeadline (unitParts.ts), untaggedMarks (warehouseCards.ts)
// — matched onto the unit's mark with the same two conventions
// fromProject.ts already uses to pull windows from the plans:
// normalizeMarkCode for the PHYSICAL opening (twin-aware: "13-1" and "13-2"
// are different units, different glow, different block state), markKeyOf
// for the BASE mark a package is tagged with (a label reads "16", never
// "16-1" — the two twins of one window ship as one set of parts).
//
// PURE: no Supabase, no three.js. ModelStudio.tsx fetches the same
// cache-shared rows every other screen already queries and hands them here
// once per render; the render layer (unitAnnotations.ts) turns the result
// into pixels.

import {
  flashFor,
  glowFor,
  normalizeMarkCode,
  type FitViewGlow,
  type FitViewViewContext,
} from "../fitview/adapter";
import { roMismatchWarning } from "../install/roMismatch";
import type { OpeningPhase } from "../install/phases";
import { blockedUnits, type UnitSession } from "../install/sessions";
import type { ProjectOpening } from "../install/types";
import type { StoragePackage } from "../storage";
import { partsHeadline, unitParts } from "../warehouse/unitParts";
import { untaggedMarks, type ScheduledMark } from "../warehouse/warehouseCards";
import { markKeyOf } from "./fromProject";
import type { UnitConfig } from "./units";

/**
 * Everything the Studio can paint onto one modeled unit. Every field is
 * independently optional — several can (and routinely do) apply to the
 * same unit at once, e.g. a unit can be red (waiting) AND owe flashing AND
 * carry a parts line all at the same time; nothing here is exclusive
 * except `partsLine`/`dim`, which are structurally impossible together
 * (dim means NO package is tagged; partsLine means at least one is).
 * A unit with no live signal at all gets an empty object, not a pile of
 * explicit falses — an absent key already means "nothing to show."
 */
export interface OverlayState {
  /** Same three colors + "none" glowFor already produces for the map.
   * Absent (not "none") when the unit's mark matches no live opening. */
  glow?: FitViewGlow;
  /** Set — possibly to null — exactly when the opening's NEWEST session
   * ended in a Block (sessions.ts's blockedUnits; newest session decides,
   * never re-derived here). Absent when not blocked. */
  blockedReason?: string | null;
  /** partsHeadline's own sentence, verbatim ("2 of 3 here", "no label yet
   * for part 2", …). Only set when at least one package is tagged to the
   * mark; an untagged mark reports through `dim` instead — repeating
   * "nothing tagged yet" as a partsLine on every dim unit would be the
   * same fact said twice. */
  partsLine?: string | null;
  /** True when flashFor says this opening's flashing is still owed
   * (needs it, nothing submitted yet) — the map's own dashed-aqua signal. */
  flashingOwed?: boolean;
  /** True when the mark is on this job's schedule and NOTHING is tagged
   * against it yet (warehouseCards.untaggedMarks — the "not tagged" card). */
  dim?: boolean;
  /** True when at least one HELD package (received/stored — a minted,
   * not-yet-arrived placeholder never counts) tagged to this mark sits in
   * no container and no shelf slot: warehouseCards' "loose" pile. */
  loose?: boolean;
  /** Count of photos on this opening's install record (Studio 100x #7 —
   * record.ts's listProjectPhotoCounts). Void included: void never
   * deletes, and a redo's before-photos are still evidence. Absent (not
   * zero) when there are none — same "absent key" convention as every
   * other field here, and cheap enough to carry on every unit at once
   * because it is a count, never a signed URL. */
  photoCount?: number;
  /** Studio 100x #14: plain-language warning when the opening's site-
   * measured RO and the mark's resolved Studio config disagree on
   * roCheck's own gap math (roMismatchWarning — no new tolerance). Absent
   * when there's nothing to say: no RO recorded, no resolved config for
   * the mark, or the numbers are fine. */
  roProblem?: string;
}

export interface LiveOverlayInput {
  /** The job's physical openings — glow/flash/block all resolve through
   * these, matched by normalizeMarkCode. */
  openings: ProjectOpening[];
  /** Packages, however broad the caller's own query is (unitParts and
   * untaggedMarks both filter to this job themselves — see `projectId`). */
  packages: StoragePackage[];
  /** THIS job's scheduled marks — e.g. listScheduledMarks([projectId]).
   * The "should exist" side of the dim/not-tagged signal. */
  scheduledMarks: ScheduledMark[];
  /** THIS job's sessions, NEWEST FIRST (listProjectSessions's own order —
   * blockedUnits relies on it, same as Dispatch and My Work). */
  sessions: UnitSession[];
  /** THIS job's opening_phases rows — folded into a submitted-flashing set
   * the same way MapsInteractive.tsx does, so flashFor sees the same
   * world here as it does on the map. */
  phases: OpeningPhase[];
  /** Opening ids whose qc_checks row says 'passed' (listQcPassedOpeningIds). */
  qcPassedOpeningIds: string[];
  /** Opening id -> photo count on its install record
   * (listProjectPhotoCounts). A plain count, never a signed URL — the
   * whole point is that every unit can carry this at once with nothing
   * signed until somebody actually taps one. */
  photoCounts: Map<string, number>;
  /** Mark (BASE — markKeyOf-keyed) -> resolved Studio config, when the
   * caller has one (catalog-beats-spec — resolveMarkConfig, the same
   * priority signatureSync uses). Optional and only feeds the RO-mismatch
   * check (#14, `roProblem` above); a caller that doesn't pass this simply
   * gets no roProblem anywhere, same as before this field existed. */
  configByMark?: Map<string, UnitConfig>;
  /** The signed-in profile, for glowFor's "my windows" scoping. */
  viewerId: string | null;
  /** Foreman+ sees every installer's load; installers see only their own. */
  managerView: boolean;
  /** The job `packages` and `scheduledMarks` get filtered against — both
   * unitParts and untaggedMarks are job-scoped reads. */
  projectId: string;
}

/**
 * One OverlayState per modeled unit, keyed by the EXACT string handed in
 * (a studio item's `itemName`) — callers never normalize twice, they just
 * `map.get(item.metadata.itemName)`.
 */
export function buildLiveOverlay(
  input: LiveOverlayInput,
  markCodes: readonly string[],
): Map<string, OverlayState> {
  // The same view context MapsInteractive.tsx builds for glowFor/flashFor,
  // wired from the same raw rows the map's own queries fetch — the Studio
  // can never disagree with the map, because it runs the exact same rule
  // over the exact same data.
  const view: FitViewViewContext = {
    viewerId: input.viewerId,
    managerView: input.managerView,
    qcPassedOpeningIds: new Set(input.qcPassedOpeningIds),
    flashedOpeningIds: new Set(
      input.phases
        .filter((p) => p.kind === "flashing" && p.status === "submitted")
        .map((p) => p.opening_id),
    ),
  };

  // One opening per normalized code — "last wins" if a code ever repeats,
  // the same convention buildAuthoredJob uses (adapter.ts).
  const openingByCode = new Map<string, ProjectOpening>();
  for (const o of input.openings) {
    openingByCode.set(normalizeMarkCode(o.opening_code), o);
  }

  // Derived once for the whole job: which openings are blocked right now,
  // and why. blockedUnits already returns one row per blocked opening.
  const blockedByOpeningId = new Map(
    blockedUnits(input.sessions).map((b) => [b.openingId, b.reason]),
  );

  // Marks scheduled on this job with nothing tagged at all — the dim set.
  const untagged = new Set(
    untaggedMarks(input.packages, input.scheduledMarks).map((m) => m.mark_code),
  );

  const out = new Map<string, OverlayState>();
  for (const code of markCodes) {
    const state: OverlayState = {};

    // Physical-opening signals: twin-aware, so "13-1" and "13-2" (or the
    // survey spellings "13A"/"13B") each get their OWN glow/flash/block.
    const opening = openingByCode.get(normalizeMarkCode(code));
    if (opening) {
      state.glow = glowFor(opening, view);
      if (flashFor(opening, view) === "needed") state.flashingOwed = true;
      if (blockedByOpeningId.has(opening.id)) {
        state.blockedReason = blockedByOpeningId.get(opening.id) ?? null;
      }
      const photoCount = input.photoCounts.get(opening.id);
      if (photoCount) state.photoCount = photoCount;

      // RO-mismatch (#14): only possible with BOTH a physical opening (to
      // read ro_width_in/ro_height_in off) and a resolved config for its
      // mark — roMismatchWarning does the actual gap math, verbatim.
      if (input.configByMark) {
        const config = input.configByMark.get(markKeyOf(code));
        if (config) {
          const problem = roMismatchWarning(
            { ro_width_in: opening.ro_width_in, ro_height_in: opening.ro_height_in },
            config,
          );
          if (problem) state.roProblem = problem;
        }
      }
    }

    // Package signals: BASE mark — markKeyOf, exactly as fromProject's own
    // catalog lookup, because a package is tagged "16", never "16-1".
    const mark = markKeyOf(code);
    const report = unitParts(input.packages, input.projectId, mark);
    if (report.rows.length > 0) {
      state.partsLine = partsHeadline(report).text;
      // Loose reads only packages still the warehouse's own problem — a
      // minted (not-yet-arrived) placeholder has nowhere to sit BY DESIGN
      // and must never trip the alarm.
      const held = report.rows.filter(
        (p) => p.status === "received" || p.status === "stored",
      );
      if (held.some((p) => !p.container_id && !p.location_id)) {
        state.loose = true;
      }
    } else if (untagged.has(mark)) {
      state.dim = true;
    }

    out.set(code, state);
  }
  return out;
}

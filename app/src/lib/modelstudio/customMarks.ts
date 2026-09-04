// Wave W (w-walls-spec.md, 2026-08-31), W4 — custom marks from Studio.
//
// "+ Add window"/"+ Add door" units that aren't schedule marks can become
// REAL marks: naming one in Studio is a draft; Submit final lists the
// genuinely new ones plainly ("Adds 2 new marks to this job: D-11, W-A") and
// registers them on confirm. CAD-WINS, unchanged: extraction still never
// invents marks. HUMANS may, deliberately, from Studio — the confirm dialog
// is the deliberateness (see CONTEXT.md's "Custom marks" paragraph).
//
// Pure here on purpose: normalizing, deduping and the confirm sentence are
// all logic worth unit-testing without a database or a mounted page. The
// actual writes (install/api.ts's registerCustomMark) are three existing
// server paths — addProjectMark, addOpening, and a plain insert into
// project_mark_specs (RLS already allows a foreman+ insert there; no
// migration needed) — this module only decides WHICH drafts are new and
// WHAT to send them.

import { normalizeMarkCode } from "../fitview/adapter";
import { specKindColumns } from "../install/unitKind";

/** One unit named as a mark in Studio, not yet known to reach confirm. */
export interface CustomMarkDraft {
  code: string;
  kind: "window" | "door";
  /** Millimetres — Studio's own unit, same as unitConfig elsewhere. */
  wMm: number;
  hMm: number;
}

/** A draft that survived dedup against the job's already-known marks. */
export interface CustomMarkAddition extends CustomMarkDraft {
  /** Rounded for project_mark_specs.width_in/height_in (whole inches, same
   * as every other size on that table — decoded manufacturer sizes are
   * whole inches too). */
  widthIn: number;
  heightIn: number;
}

/** The SAME normalization the rest of the map uses for mark codes
 * (fitview/adapter.ts's normalizeMarkCode, which also equates the survey
 * ("13A") and extraction ("13-1") spellings) — a mark is "known" under any
 * spelling that already resolves to it. */
export function markKey(code: string): string {
  return normalizeMarkCode(code);
}

function mmToIn(mm: number): number {
  return Math.round(mm / 25.4);
}

/**
 * From every draft named in Studio this session, the ones that are
 * genuinely new to the job — not already a scheduled mark or opening, and
 * not a repeat of an earlier draft (last write for a given code wins, same
 * as re-typing a name in place). Un-named units and blank codes never reach
 * here (the caller only builds a draft once a code is typed).
 */
export function selectNewCustomMarks(
  drafts: readonly CustomMarkDraft[],
  knownCodes: readonly string[],
): CustomMarkAddition[] {
  const known = new Set(knownCodes.map(markKey));
  const byKey = new Map<string, CustomMarkDraft>();
  for (const d of drafts) {
    const code = d.code.trim();
    if (!code) continue;
    if (!(d.wMm > 0) || !(d.hMm > 0)) continue;
    byKey.set(markKey(code), { ...d, code });
  }
  const out: CustomMarkAddition[] = [];
  for (const [key, d] of byKey) {
    if (known.has(key)) continue;
    out.push({ ...d, widthIn: mmToIn(d.wMm), heightIn: mmToIn(d.hMm) });
  }
  // Stable, readable order for the confirm dialog and the registration loop.
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

/** The confirm-dialog line ("Adds 2 new marks to this job: D-11, W-A"), or
 * null when there's nothing new to announce — Submit final says nothing
 * extra on an ordinary publish. */
export function describeCustomMarkAdditions(marks: readonly CustomMarkAddition[]): string | null {
  if (marks.length === 0) return null;
  const codes = marks.map((m) => m.code).join(", ");
  return `Adds ${marks.length} new mark${marks.length === 1 ? "" : "s"} to this job: ${codes}`;
}

/** The three payloads registerCustomMark (install/api.ts) sends for one
 * addition — split out so the shape is checkable without a live database. */
export interface CustomMarkRegistrationPayload {
  markCode: string;
  opening: { opening_code: string; confirmed: true };
  spec: {
    project_id: string;
    mark_code: string;
    width_in: number;
    height_in: number;
    operation: "Window" | "Door";
    source: "manual";
    confirmed: true;
    /** Wave X — see below. Written by the app's one classifier. */
    unit_kind: "window" | "door" | null;
    door_kind: "slider" | "french" | "bifold" | "swing" | "other" | null;
  };
}

export function buildCustomMarkRegistrationPayload(
  projectId: string,
  mark: CustomMarkAddition,
): CustomMarkRegistrationPayload {
  const operation = mark.kind === "door" ? "Door" : "Window";
  return {
    markCode: mark.code,
    opening: { opening_code: mark.code, confirmed: true },
    spec: {
      project_id: projectId,
      mark_code: mark.code,
      width_in: mark.widthIn,
      height_in: mark.heightIn,
      operation,
      source: "manual",
      confirmed: true,
      // Wave X: through the SAME classifier every other specs write path uses,
      // rather than mapping kind straight across. A Studio unit carries no
      // style line, so a door registered here reads as "other" until somebody
      // says which — which is exactly what the paperwork says about it.
      ...specKindColumns({ operation }),
    },
  };
}

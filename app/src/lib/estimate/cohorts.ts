// The FALLBACK LADDER (CONTEXT.md): when a cohort is thin, fall back a
// rung — panel formula → exact signature → same kind + panel count →
// same kind → global. A rung shows at n ≥ 5 (the formula rung has its
// own, higher bar — see panelFormula.ts); the rung and its sample count
// are ALWAYS part of the answer ("same kind · n=23" — the label is the
// real safeguard, not the threshold). Below the global rung: "no
// estimate yet", and a clearly-labelled manual guess is the only number
// allowed.
//
// Foreman+ display only (standing decision: installer-vs-average is
// never visible to installers). Evidence flows in behind EvidenceSource:
// today that's install_events.minutes; the sessions effort (ADR-0001)
// swaps the source without touching this ladder.

import { supabase } from "../supabase";
import { isMissingColumn } from "../schemaErrors";
import { dataOffKind, type DataOffKind } from "../install/dataOff";
import { sumMixes, type SignatureTierV1, type SignatureV1 } from "./signature";
import { estimateForSignatureViaFormula, fitPanelFormula, type PanelFormulaFit } from "./panelFormula";

export const MIN_COHORT_N = 5;

export interface CohortEvidence {
  sigKey: string;
  signature: SignatureV1 | null;
  minutes: number;
  /** The unit the sample came from, when known — lets sources be merged
   * without double-counting a unit. Never affects ladder resolution. */
  unitId?: string;
  /**
   * Wave E: the unit's "data off" reason, when its record is flagged wrong.
   * Carried on the sample rather than looked up later so the ONE filter
   * (partitionDataOff, applied in useCohortEvidence) can name why it dropped
   * a sample instead of silently shrinking the pool.
   */
  dataOff?: DataOffKind | null;
}

/**
 * Split the pool into what may be averaged and what may not.
 *
 * WHY A UNIT WITH A DATA-OFF FLAG IS NOT EVIDENCE (wave E, Q12): the minutes
 * are real, but what they are minutes OF is not. A unit installed against a
 * wrong-size order, or a mirrored one, or one that is not what the plans
 * drew, is timed against a signature that describes a different window — so
 * folding it into a cohort teaches the estimator the wrong thing about a
 * shape we never actually installed. It is excluded WITH ITS REASON, and
 * counted separately as the data-off rate, so the pool never quietly shrinks
 * with nobody able to say by how much or why.
 *
 * Timing note: the flag is read as it stands, not as it stood at the moment
 * somebody tapped Finish — nothing stores a history of flags. That is the
 * behaviour worth having anyway: a foreman clearing the flag is a person
 * saying the record is right now, which is exactly when the sample becomes
 * trustworthy again, and it rejoins the pool.
 */
export function partitionDataOff(evidence: readonly CohortEvidence[]): {
  usable: CohortEvidence[];
  excluded: { unitId?: string; sigKey: string; reason: DataOffKind }[];
} {
  const usable: CohortEvidence[] = [];
  const excluded: { unitId?: string; sigKey: string; reason: DataOffKind }[] = [];
  for (const e of evidence) {
    if (e.dataOff) excluded.push({ unitId: e.unitId, sigKey: e.sigKey, reason: e.dataOff });
    else usable.push(e);
  }
  return { usable, excluded };
}

export type LadderRung =
  | "formula"
  | "exact"
  | "kind+panels"
  | "kind"
  | "global"
  | "none"
  | "manual";

export interface CohortEstimate {
  rung: LadderRung;
  n: number;
  /** Cohort median minutes — null on the "none" rung. */
  minutes: number | null;
  /** Always shown next to the number: the honesty label. */
  label: string;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Studio 100x #24: the panel formula, fit once per evidence pool and
// cached on the array's own identity. Every estimateForSignature call in
// one render (estimateJobUnits loops it once per opening) shares this,
// so "on demand" never means "re-solve the regression per row." A fresh
// evidence array (a new fetch) is a fresh cache entry; nothing here is
// ever mutated.
const formulaFitCache = new WeakMap<readonly CohortEvidence[], PanelFormulaFit | null>();

function resolveFormulaFit(evidence: readonly CohortEvidence[]): PanelFormulaFit | null {
  if (formulaFitCache.has(evidence)) return formulaFitCache.get(evidence) ?? null;
  const fit = fitPanelFormula(evidence);
  formulaFitCache.set(evidence, fit);
  return fit;
}

/**
 * Resolve the ladder for one target signature. Rungs never cross a
 * signature VERSION (a v1 cohort and a v2 cohort are never mixed), and a
 * rung only answers at n ≥ minN.
 */
export function estimateForSignature(
  target: { signature: SignatureV1; sigKey: string },
  evidence: readonly CohortEvidence[],
  minN: number = MIN_COHORT_N,
): CohortEstimate {
  const t = target.signature;

  // NEW TOP RUNG (CONTEXT.md's panel-level formula): tried before every
  // other rung, "exact" included — see panelFormula.ts's own gate for
  // why. Silently absent below its gate, and per-target absent again
  // when this target's mix needs a mechanism the fit never saw; either
  // way the ladder below falls through completely unchanged.
  const formulaFit = resolveFormulaFit(evidence);
  if (formulaFit) {
    const minutes = estimateForSignatureViaFormula(t, formulaFit);
    if (minutes != null) {
      return {
        rung: "formula",
        n: formulaFit.fittedFrom,
        minutes,
        label: `formula fit from ${formulaFit.fittedFrom} units`,
      };
    }
  }

  const sameV = evidence.filter((e) => e.signature?.v === t.v);

  const rungs: { rung: LadderRung; label: (n: number) => string; pick: CohortEvidence[] }[] = [
    {
      rung: "exact",
      label: (n) => `this exact unit · n=${n}`,
      pick: sameV.filter((e) => e.sigKey === target.sigKey),
    },
    {
      rung: "kind+panels",
      label: (n) => `same kind · ${t.panelCount} panels · n=${n}`,
      pick: sameV.filter(
        (e) => e.signature!.kind === t.kind && e.signature!.panelCount === t.panelCount,
      ),
    },
    {
      rung: "kind",
      label: (n) => `same kind (${t.kind}s) · n=${n}`,
      pick: sameV.filter((e) => e.signature!.kind === t.kind),
    },
    {
      rung: "global",
      label: (n) => `all units · n=${n}`,
      pick: [...sameV],
    },
  ];

  for (const r of rungs) {
    if (r.pick.length >= minN) {
      return {
        rung: r.rung,
        n: r.pick.length,
        minutes: median(r.pick.map((e) => e.minutes)),
        label: r.label(r.pick.length),
      };
    }
  }
  return {
    rung: "none",
    n: sameV.length,
    minutes: null,
    label: `no estimate yet · ${sameV.length} install${sameV.length === 1 ? "" : "s"} recorded`,
  };
}

/** The only number allowed below the ladder: a human's guess, wearing its
 * label — never dressed as data. */
export function manualEstimate(minutes: number): CohortEstimate {
  return { rung: "manual", n: 0, minutes, label: "manual estimate — not from data" };
}

export type EvidenceSource = () => Promise<CohortEvidence[]>;

/**
 * Today's evidence: install_events minutes joined to their opening's
 * stored signature, company-wide (cohorts cross jobs by design). Voided
 * events and unsigned openings drop out. The sessions effort replaces
 * this function; the ladder above never changes.
 */
export const installEventsEvidence: EvidenceSource = async () => {
  // The flag columns arrive with 20260977000000. A bundle that reaches a phone
  // before the migration reaches the server must still produce evidence, so the
  // read peels them off rather than throwing the whole pool away — a database
  // with no flag column has no flagged units either, which is the truth there.
  const withFlags = await supabase
    .from("install_events")
    .select("minutes, opening:project_openings!inner(id, sig_key, signature, flag_kind, flag_note)")
    .is("voided_at", null)
    .not("minutes", "is", null)
    .not("opening.sig_key", "is", null);
  let res = withFlags;
  if (res.error && isMissingColumn(res.error, "flag_kind")) {
    res = (await supabase
      .from("install_events")
      .select("minutes, opening:project_openings!inner(id, sig_key, signature)")
      .is("voided_at", null)
      .not("minutes", "is", null)
      .not("opening.sig_key", "is", null)) as typeof res;
  }
  if (res.error) return [];
  const rows = (res.data ?? []) as unknown as {
    minutes: number;
    opening:
      | {
          id: string;
          sig_key: string;
          signature: SignatureV1 | null;
          flag_kind?: string | null;
          flag_note?: string | null;
        }
      | null;
  }[];
  return rows
    .filter((r) => r.opening?.sig_key && r.minutes != null && r.minutes >= 0)
    .map((r) => ({
      sigKey: r.opening!.sig_key,
      signature: r.opening!.signature,
      minutes: r.minutes,
      unitId: r.opening!.id,
      dataOff: dataOffKind(r.opening!),
    }));
};

// -------------------------------------------------- sessions evidence

interface SessionEvidenceRow {
  started_at: string;
  ended_at: string | null;
  role: "install" | "helper";
  is_rework: boolean;
  end_reason: string | null;
  opening: {
    id: string;
    sig_key: string | null;
    signature: SignatureV1 | null;
    /** Wave E. Absent on a database without the column — no flags there. */
    flag_kind?: string | null;
    flag_note?: string | null;
  } | null;
}

/**
 * PURE: fold session rows into per-UNIT evidence samples. One sample per
 * unit = Σ its non-rework install+helper session minutes (480-cap each) —
 * and only units with at least one FINISHED round count; half-done work
 * is not evidence. Blocked time is excluded structurally: no session runs
 * while a unit sits blocked.
 */
export function evidenceFromSessions(
  rows: readonly SessionEvidenceRow[],
): CohortEvidence[] {
  const perUnit = new Map<
    string,
    {
      sigKey: string;
      signature: SignatureV1 | null;
      minutes: number;
      finished: boolean;
      dataOff: DataOffKind | null;
    }
  >();
  for (const r of rows) {
    const o = r.opening;
    if (!o?.sig_key || !r.ended_at) continue;
    const entry =
      perUnit.get(o.id) ??
      {
        sigKey: o.sig_key,
        signature: o.signature,
        minutes: 0,
        finished: false,
        dataOff: dataOffKind(o),
      };
    if (!r.is_rework) {
      const mins = Math.max(
        0,
        Math.min(480, Math.floor((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60000)),
      );
      entry.minutes += mins;
    }
    if (r.end_reason === "finish") entry.finished = true;
    perUnit.set(o.id, entry);
  }
  return [...perUnit.entries()]
    .filter(([, u]) => u.finished && u.minutes > 0)
    .map(([unitId, u]) => ({
      sigKey: u.sigKey,
      signature: u.signature,
      minutes: u.minutes,
      unitId,
      dataOff: u.dataOff,
    }));
}

/**
 * The sessions-era evidence source (spec .scratch/sessions): real
 * man-minutes per unit, company-wide. The ladder above never changed —
 * exactly the swap ticket 04 promised.
 */
export const sessionsEvidence: EvidenceSource = async () => {
  const cols = (flags: boolean) =>
    `started_at, ended_at, role, is_rework, end_reason, opening:project_openings!inner(id, sig_key, signature${
      flags ? ", flag_kind, flag_note" : ""
    })`;
  // Same peel-back as installEventsEvidence: a phone ahead of the migration
  // still gets a pool, it just has no flags in it to exclude.
  let res = await supabase
    .from("unit_sessions")
    .select(cols(true))
    .not("ended_at", "is", null)
    .not("opening.sig_key", "is", null);
  if (res.error && isMissingColumn(res.error, "flag_kind")) {
    res = (await supabase
      .from("unit_sessions")
      .select(cols(false))
      .not("ended_at", "is", null)
      .not("opening.sig_key", "is", null)) as typeof res;
  }
  if (res.error) return [];
  return evidenceFromSessions((res.data ?? []) as unknown as SessionEvidenceRow[]);
};


/**
 * Merge evidence sources without double-counting: a unit with SESSION
 * evidence (real man-minutes) never also contributes its legacy
 * wall-clock figure. Legacy-only units still count — pre-sessions test
 * data beats an empty screen, honestly labeled by the caller.
 */
export function combineEvidence(
  sessions: readonly CohortEvidence[],
  legacy: readonly CohortEvidence[],
): CohortEvidence[] {
  const covered = new Set(sessions.map((e) => e.unitId).filter(Boolean));
  return [...sessions, ...legacy.filter((e) => !e.unitId || !covered.has(e.unitId))];
}

/** "story 2" for one tier; "stories 1-3" across several — tiers are
 * already in ascending story order (computeSignature). A single tier
 * reproduces the exact pre-#22 label, byte for byte. */
function storyLabel(tiers: readonly SignatureTierV1[]): string {
  const first = tiers[0]?.story;
  if (first == null) return "story ?"; // untraced propagates to every tier — see computeSignature
  const last = tiers[tiers.length - 1]?.story;
  return last != null && last !== first ? `stories ${first}-${last}` : `story ${first}`;
}

/** Short human line for a signature — the estimating screen's row label.
 * Multi-tier (Studio 100x #22): the mix folds every tier's panels
 * together (sumMixes) so it always matches `panelCount`'s own total, and
 * the story bit becomes a range across the tiers' own ascending order. */
export function describeSignature(sig: SignatureV1): string {
  const mix = Object.entries(sumMixes(sig.tiers.map((t) => t.mix)))
    .map(([k, n]) => `${n} ${k}`)
    .join(" + ");
  const bits = [
    sig.kind,
    `${sig.panelCount} panel${sig.panelCount === 1 ? "" : "s"} (${mix})`,
    sig.corner === "corner" ? "corner" : null,
    storyLabel(sig.tiers),
    sig.insetOutset ?? null,
  ].filter(Boolean);
  return bits.join(" · ");
}

export interface JobEstimateRow {
  openingId: string;
  code: string;
  installed: boolean;
  /** null = no stored signature yet (specs unconfirmed / not recomputed). */
  described: string | null;
  estimate: CohortEstimate | null;
}

/**
 * PURE: the foreman's job view — one row per unit, the ladder resolved
 * per signature, totals over the NOT-installed units (the actionable
 * number). Units without a signature are counted out loud, never guessed.
 */
export function estimateJobUnits(
  openings: readonly {
    id: string;
    opening_code: string;
    status?: string | null;
    sig_key?: string | null;
    signature?: unknown;
  }[],
  evidence: readonly CohortEvidence[],
  minN: number = MIN_COHORT_N,
): {
  rows: JobEstimateRow[];
  remainingMin: number;
  remainingCovered: number;
  remainingUncovered: number;
  unsigned: number;
} {
  const rows: JobEstimateRow[] = [];
  let remainingMin = 0;
  let remainingCovered = 0;
  let remainingUncovered = 0;
  let unsigned = 0;
  for (const o of openings) {
    const installed = o.status === "installed";
    const sig = (o.signature ?? null) as SignatureV1 | null;
    if (!o.sig_key || !sig) {
      unsigned += 1;
      rows.push({
        openingId: o.id,
        code: o.opening_code,
        installed,
        described: null,
        estimate: null,
      });
      continue;
    }
    const est = estimateForSignature({ signature: sig, sigKey: o.sig_key }, evidence, minN);
    rows.push({
      openingId: o.id,
      code: o.opening_code,
      installed,
      described: describeSignature(sig),
      estimate: est,
    });
    if (!installed) {
      if (est.minutes != null) {
        remainingMin += est.minutes;
        remainingCovered += 1;
      } else {
        remainingUncovered += 1;
      }
    }
  }
  return { rows, remainingMin, remainingCovered, remainingUncovered, unsigned };
}

// The FALLBACK LADDER (CONTEXT.md): when a cohort is thin, fall back a
// rung — exact signature → same kind + panel count → same kind → global.
// A rung shows at n ≥ 5; the rung and its sample count are ALWAYS part of
// the answer ("same kind · n=23" — the label is the real safeguard, not
// the threshold). Below the global rung: "no estimate yet", and a
// clearly-labelled manual guess is the only number allowed.
//
// Foreman+ display only (standing decision: installer-vs-average is
// never visible to installers). Evidence flows in behind EvidenceSource:
// today that's install_events.minutes; the sessions effort (ADR-0001)
// swaps the source without touching this ladder.

import { supabase } from "../supabase";
import type { SignatureV1 } from "./signature";

export const MIN_COHORT_N = 5;

export interface CohortEvidence {
  sigKey: string;
  signature: SignatureV1 | null;
  minutes: number;
}

export type LadderRung = "exact" | "kind+panels" | "kind" | "global" | "none" | "manual";

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
  const { data, error } = await supabase
    .from("install_events")
    .select("minutes, opening:project_openings!inner(sig_key, signature)")
    .is("voided_at", null)
    .not("minutes", "is", null)
    .not("opening.sig_key", "is", null);
  if (error) return [];
  const rows = (data ?? []) as unknown as {
    minutes: number;
    opening: { sig_key: string; signature: SignatureV1 | null } | null;
  }[];
  return rows
    .filter((r) => r.opening?.sig_key && r.minutes != null && r.minutes >= 0)
    .map((r) => ({
      sigKey: r.opening!.sig_key,
      signature: r.opening!.signature,
      minutes: r.minutes,
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
    { sigKey: string; signature: SignatureV1 | null; minutes: number; finished: boolean }
  >();
  for (const r of rows) {
    const o = r.opening;
    if (!o?.sig_key || !r.ended_at) continue;
    const entry =
      perUnit.get(o.id) ??
      { sigKey: o.sig_key, signature: o.signature, minutes: 0, finished: false };
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
  return [...perUnit.values()]
    .filter((u) => u.finished && u.minutes > 0)
    .map((u) => ({ sigKey: u.sigKey, signature: u.signature, minutes: u.minutes }));
}

/**
 * The sessions-era evidence source (spec .scratch/sessions): real
 * man-minutes per unit, company-wide. The ladder above never changed —
 * exactly the swap ticket 04 promised.
 */
export const sessionsEvidence: EvidenceSource = async () => {
  const { data, error } = await supabase
    .from("unit_sessions")
    .select(
      "started_at, ended_at, role, is_rework, end_reason, opening:project_openings!inner(id, sig_key, signature)",
    )
    .not("ended_at", "is", null)
    .not("opening.sig_key", "is", null);
  if (error) return [];
  return evidenceFromSessions((data ?? []) as unknown as SessionEvidenceRow[]);
};

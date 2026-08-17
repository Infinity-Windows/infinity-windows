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

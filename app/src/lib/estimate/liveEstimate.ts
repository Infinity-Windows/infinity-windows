// The LIVE cohort estimate for a UnitConfig that has no opening yet — the
// unit builder's live preview line (Studio 100x #21) and the catalog
// list's evidence-confidence badge (#26). Same evidence, same fallback
// ladder (CONTEXT.md) as the foreman's estimating screen
// (components/install/SignatureEstimates.tsx): useCohortEvidence below is
// the one place that knows the evidence query keys, and every screen that
// needs the pool mounts it, so React Query serves them all one cached
// fetch instead of each opening its own.
//
// A drafted or catalog unit has no traced opening, so its story is
// honestly unknown — `story` is always null here, the same "untraced"
// value a real job carries before it's traced. That's not a loss: the
// ladder's kind+panels/kind rungs don't look at story at all, so most
// units still land a useful estimate; only the "exact" rung ever needs it.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  combineEvidence,
  estimateForSignature,
  installEventsEvidence,
  partitionDataOff,
  sessionsEvidence,
  type CohortEstimate,
  type CohortEvidence,
} from "./cohorts";
import { computeSignature } from "./signature";
import type { UnitConfig } from "../modelstudio/units";

/**
 * The estimating evidence, fetched once and shared — the only place that
 * knows the evidence query keys and staleTime. SignatureEstimates.tsx,
 * DataHub.tsx and the Studio screens all mount this, so whichever loads
 * first fetches and the rest reuse the cache.
 *
 * `evidence` is the combined pool the ladder consumes (sessions-first,
 * legacy deduped in). The raw `sessions`/`legacy` pools ride along for
 * the screens that report provenance — the estimating screen's
 * "N legacy-timed units" line and the Data Tab's timing-source counts.
 */
export function useCohortEvidence(): {
  evidence: CohortEvidence[];
  sessions: CohortEvidence[];
  legacy: CohortEvidence[];
  /**
   * Wave E: the samples this hook REFUSED to hand out, each with the reason
   * its unit's record was flagged wrong. Read by the Data Tab so the pool can
   * never shrink without somebody being able to say by how much and why.
   */
  dataOff: { unitId?: string; sigKey: string; reason: string }[];
} {
  const sessions = useQuery({
    queryKey: ["cohortEvidence", "sessions"],
    queryFn: sessionsEvidence,
    staleTime: 60_000,
  });
  const legacy = useQuery({
    queryKey: ["cohortEvidence", "legacy"],
    queryFn: installEventsEvidence,
    staleTime: 60_000,
  });
  return useMemo(() => {
    // THE ONE PLACE data-off units leave the estimating world (wave E, Q12).
    // Every screen that estimates — the foreman's job list, the Data Tab, the
    // Studio's live line and its catalog badge — takes its pool from this
    // hook, so filtering here is filtering everywhere, and nothing downstream
    // has to remember the rule. Both raw pools are filtered too: `sessions` is
    // what the Data Tab reads actual minutes from, and an actual with no
    // estimate beside it would put a flagged unit straight back into the
    // estimate-vs-actual health count by the back door.
    const s = partitionDataOff(sessions.data ?? []);
    const l = partitionDataOff(legacy.data ?? []);
    return {
      evidence: combineEvidence(s.usable, l.usable),
      sessions: s.usable,
      legacy: l.usable,
      dataOff: [...s.excluded, ...l.excluded],
    };
  }, [sessions.data, legacy.data]);
}

/**
 * PURE: the ladder's answer for one config, right now. Inset/outset comes
 * off the config when the builder's 3-way control set it (#23) — a
 * drafted unit has no spec to fall back to, so there's only one source
 * to read here (signatureSync.insetOutsetOf handles the catalog-vs-spec
 * case for openings that DO have a spec).
 */
export function estimateForUnitConfig(
  config: UnitConfig,
  evidence: readonly CohortEvidence[],
): CohortEstimate {
  const { signature, sigKey } = computeSignature(config, {
    story: null,
    insetOutset: config.insetOutset ?? null,
  });
  return estimateForSignature({ signature, sigKey }, evidence);
}

/**
 * #21: the unit builder's live cohort line. Recompute is a plain useMemo,
 * not a real debounce timer — computeSignature and the ladder are both
 * pure and cheap, so there's nothing to gain by delaying past the
 * config's own change.
 */
export function useUnitCohortEstimate(config: UnitConfig): CohortEstimate {
  const { evidence } = useCohortEvidence();
  return useMemo(() => estimateForUnitConfig(config, evidence), [config, evidence]);
}

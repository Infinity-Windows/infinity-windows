// The LIVE cohort estimate for a UnitConfig that has no opening yet — the
// unit builder's live preview line (Studio 100x #21) and the catalog
// list's evidence-confidence badge (#26). Same evidence, same fallback
// ladder (CONTEXT.md) as the foreman's estimating screen
// (components/install/SignatureEstimates.tsx): the query keys below are
// copied verbatim so React Query serves one cached fetch to every screen
// that asks for it instead of each one opening its own.
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
  sessionsEvidence,
  type CohortEstimate,
  type CohortEvidence,
} from "./cohorts";
import { computeSignature } from "./signature";
import type { UnitConfig } from "../modelstudio/units";

/**
 * The estimating screen's evidence, fetched once and shared: identical
 * query keys to SignatureEstimates.tsx / DataHub.tsx, so a screen that
 * mounts alongside (or after) one of those reuses the cached fetch
 * instead of doubling it.
 */
export function useCohortEvidence(): CohortEvidence[] {
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
  return useMemo(
    () => combineEvidence(sessions.data ?? [], legacy.data ?? []),
    [sessions.data, legacy.data],
  );
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
  const evidence = useCohortEvidence();
  return useMemo(() => estimateForUnitConfig(config, evidence), [config, evidence]);
}

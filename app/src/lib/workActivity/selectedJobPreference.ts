// Selected-job production Work route (2026-10-04): the explicit job pick,
// held in memory only and bound to the exact owner/generation that made it.
//
// Nothing here is persisted — a reload starts the picker over, same as any
// other in-memory React state. The pick survives a later schedule or
// recent-jobs read resolving after the tap, because nothing here recomputes
// it from those reads; it is cleared ONLY by an identity change (sign-out, a
// different login generation) or by a fresh authorized job list that no
// longer contains it — never merely because a recommendation arrived first
// or later than the pick. The scheduled job is a recommendation shown by the
// caller, never an implicit selection made here.

import { useEffect, useMemo, useState } from "react";

interface Held {
  ownerKey: string;
  jobId: string;
}

export interface SelectedJobPreference {
  jobId: string | null;
  pick: (jobId: string) => void;
  clear: () => void;
}

/**
 * @param ownerKey Identity the pick is bound to, e.g. `${owner}:${generation}`.
 *   A change clears the pick — the same remount-by-identity key the rest of
 *   this route's adapter uses.
 * @param authorizedJobIds The caller's current, fresh job list, or null
 *   while it has not yet answered. A non-null list that no longer contains
 *   the held pick clears it immediately.
 */
export function useSelectedJobPreference(
  ownerKey: string | null,
  authorizedJobIds: readonly string[] | null,
): SelectedJobPreference {
  const [held, setHeld] = useState<Held | null>(null);
  useEffect(() => {
    if (held && (!ownerKey || held.ownerKey !== ownerKey || authorizedJobIds && !authorizedJobIds.includes(held.jobId))) setHeld(null);
  }, [held, ownerKey, authorizedJobIds]);
  const live = useMemo(() => {
    if (!held || !ownerKey || held.ownerKey !== ownerKey) return null;
    if (authorizedJobIds && !authorizedJobIds.includes(held.jobId)) return null;
    return held;
  }, [held, ownerKey, authorizedJobIds]);
  return {
    jobId: live?.jobId ?? null,
    pick: (jobId: string) => {
      if (!ownerKey) return;
      setHeld({ ownerKey, jobId });
    },
    clear: () => setHeld(null),
  };
}

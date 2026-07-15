/** Rank units for opening assignment: prefer staged/loaded, then same project. */
export const ASSIGN_STATUS_RANK: Record<string, number> = {
  staged: 0,
  loaded: 1,
  in_warehouse: 2,
  inbound: 3,
  damaged: 9,
  installed: 10,
};

export interface AssignCandidate {
  id: string;
  window_id: string;
  status: string;
  project_id: string | null;
  window_type_id: string;
  locations?: { address: string } | null;
  window_types?: { type_code: string } | null;
}

export function rankAssignCandidates<T extends AssignCandidate>(
  units: T[],
  opts: {
    preferredTypeId?: string | null;
    projectId?: string | null;
  } = {},
): T[] {
  const { preferredTypeId = null, projectId = null } = opts;
  return [...units]
    .filter((u) => u.status !== "installed")
    .filter((u) => !preferredTypeId || u.window_type_id === preferredTypeId)
    .sort((a, b) => {
      const typeBoostA =
        preferredTypeId && a.window_type_id === preferredTypeId ? 0 : 1;
      const typeBoostB =
        preferredTypeId && b.window_type_id === preferredTypeId ? 0 : 1;
      if (typeBoostA !== typeBoostB) return typeBoostA - typeBoostB;

      const projA = projectId && a.project_id === projectId ? 0 : 1;
      const projB = projectId && b.project_id === projectId ? 0 : 1;
      if (projA !== projB) return projA - projB;

      const rankA = ASSIGN_STATUS_RANK[a.status] ?? 5;
      const rankB = ASSIGN_STATUS_RANK[b.status] ?? 5;
      if (rankA !== rankB) return rankA - rankB;

      const addrA = a.locations?.address ?? "~";
      const addrB = b.locations?.address ?? "~";
      return addrA.localeCompare(addrB) || a.window_id.localeCompare(b.window_id);
    });
}

export function formatAssignMeta(unit: AssignCandidate): string {
  const slot = unit.locations?.address;
  const status = unit.status.replace(/_/g, " ");
  return slot ? `${slot} · ${status}` : status;
}

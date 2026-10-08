import { useCallback } from "react";
import { listWorkUnits } from "../customWork/api";
import { useRouteRead } from "./useRouteRead";
import type { WorkUnitChoice } from "../../components/work/ProjectActivityView";
/** Enumeration is fresh and ephemeral; never mount useWork's all-job sync. */
export function useRouteJobUnits(projectId: string | null, enabled: boolean) {
  const read = useCallback(() => listWorkUnits(projectId!), [projectId]);
  const query = useRouteRead(`units:${projectId}`, enabled && Boolean(projectId), read);
  const units: readonly WorkUnitChoice[] = (query.data ?? [])
    .filter(unit => unit.project_id === projectId)
    .map(unit => ({ id: unit.id, label: unit.label, detail: unit.type_label }));
  return { ...query, units };
}

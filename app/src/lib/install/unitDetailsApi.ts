import { supabase } from "../supabase";
import { getOpening } from "./api";
import type { PlannedJob } from "../installerWorkflow/sharedPlan";
import type { QueryClient } from "@tanstack/react-query";
import type { UnitDetailsWrite } from "./unitDetails";
import type { ProjectOpening } from "./types";

export async function saveUnitDetails(write: UnitDetailsWrite) {
  const { data, error } = await supabase.rpc("save_unit_details", {
    p_project: write.projectId,
    p_opening: write.id,
    p_create: write.create,
    p_code: write.code,
    p_details: write.details,
    p_previous_code: write.previousCode,
    p_previous_details: write.previousDetails,
    p_edit_id: write.editId,
    p_reason: write.reason ?? null,
  });
  if (error?.code === "23505") throw { ...error, message: "This job already has a unit with that number." };
  if (error) throw error;
  return data !== false;
}

export async function refreshUnitDetails(client: QueryClient, write: UnitDetailsWrite, applied: boolean) {
  const patch = (opening: ProjectOpening) => ({
    ...opening, opening_code: write.code, unit_details: write.details,
  });
  const listKey = ["openings", write.projectId];
  const detailKey = ["work-agenda-opening", write.projectId, write.id];
  const openingKey = ["opening", write.id];
  await Promise.all([listKey, detailKey, openingKey].map(queryKey => client.cancelQueries({ queryKey })));
  if (write.create) {
    const opening = await getOpening(write.id);
    if (opening?.project_id === write.projectId) {
      client.setQueryData<ProjectOpening[]>(listKey, rows =>
        rows?.some(row => row.id === opening.id) ? rows.map(row => row.id === opening.id ? opening : row) : [...(rows ?? []), opening]);
      client.setQueryData(detailKey, opening);
    }
  } else if (applied) {
    client.setQueryData<ProjectOpening[]>(listKey, rows => rows?.map(row => row.id === write.id ? patch(row) : row));
    client.setQueryData<ProjectOpening | null>(detailKey, row => row ? patch(row) : row);
    client.setQueryData<ProjectOpening | null>(openingKey, row => row ? patch(row) : row);
    client.setQueriesData<PlannedJob[]>({ queryKey: ["myInstallerPlan"] }, jobs => jobs?.map(job =>
      job.projectId === write.projectId && write.id in job.unitLabels
        ? { ...job, unitLabels: { ...job.unitLabels, [write.id]: write.code } } : job
    ));
  }
  void client.invalidateQueries({ queryKey: listKey });
  void client.invalidateQueries({ queryKey: detailKey });
  void client.invalidateQueries({ queryKey: openingKey });
  void client.invalidateQueries({ queryKey: ["myInstallerPlan"] });
}

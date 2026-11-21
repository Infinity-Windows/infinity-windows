import { isMissingFunction } from "../schemaErrors";
import type { ActivityDoneMark } from "./unitProgress";
import { supabase } from "../supabase";
import type { PlanBlock } from "./jobPlan";

export type SharedPlan = {
  revision: number;
  blocks: PlanBlock[];
};

export async function readSharedPlan(project: string): Promise<SharedPlan> {
  const { data, error } = await supabase.rpc("get_installer_plan", { p_project_id: project });
  if (error) throw error;
  return data;
}

export async function saveSharedPlan(project: string, revision: number, blocks: PlanBlock[]): Promise<SharedPlan> {
  const { data, error } = await supabase.rpc("save_installer_plan", {
    p_project_id: project, p_revision: revision, p_blocks: blocks,
  });
  if (error) throw error;
  return data;
}

export async function readPublishedPlan(project: string, installer?: string): Promise<PlanBlock[]> {
  const { data, error } = await supabase.rpc("get_published_installer_plan", {
    p_project_id: project, p_installer_id: installer ?? null,
  });
  if (error) throw error;
  return data;
}

export type PublishedUnitSchedule = Omit<PlanBlock, "installerIds" | "openingCrew" | "unitCrewOnly">;

export async function readPublishedUnitSchedule(project: string, opening: string): Promise<PublishedUnitSchedule[]> {
  const { data, error } = await supabase.rpc("get_workday_unit_schedule", { p_project_id: project, p_opening_id: opening });
  if (error) throw error;
  return data;
}

export type PlannedJob = {
  projectId: string;
  jobCode: string;
  jobName: string;
  blocks: PlanBlock[];
  unitLabels: Record<string, string>;
};

export async function readMyPlanWindow(start: string, end: string): Promise<PlannedJob[]> {
  const { data, error } = await supabase.rpc("get_my_installer_plan_window", {
    p_start: start, p_end: end,
  });
  if (error) throw error;
  return data;
}

export async function readActivityDone(project: string): Promise<ActivityDoneMark[]> {
  const { data, error } = await supabase.rpc("get_plan_activity_done", { p_project_id: project });
  if (isMissingFunction(error)) return [];
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

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

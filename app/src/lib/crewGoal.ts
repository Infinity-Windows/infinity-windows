import { supabase } from "./supabase";
import { isMissingFunction } from "./schemaErrors";

export interface CrewGoal {
  goal_hours: number | null;
  goal_revision: number | null;
  goal_updated_at: string | null;
  recorded_hours: number;
  running_provisional_hours: number;
  open_shifts: number;
  unresolved_shifts: number;
  allowance_hours: number | null;
  as_of: string;
}

export async function getCrewGoal(projectId: string): Promise<CrewGoal | null> {
  const { data, error } = await supabase.rpc("crew_goal_summary", { p_project_id: projectId });
  if (isMissingFunction(error)) return null;
  if (error) throw error;
  return data as CrewGoal;
}

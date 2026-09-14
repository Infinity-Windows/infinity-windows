// Wave S: the client face of the STG Windows & Doors (builder/partner) view.
// Every read here goes through a SECURITY DEFINER projection RPC
// (20260952000000_stg_projection_rpcs.sql) — there is no direct table
// query anywhere in this file, on purpose (THE WALL, S1: "no partner-facing
// view queries a crew table directly from the client"). Reads show a
// visible setup error when a projection is not deployed, so a missing migration
// cannot masquerade as a login with no shared jobs.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { isMissingFunction } from "./schemaErrors";

export interface StgJob {
  id: string;
  name: string;
  job_code: string;
  status: string;
  progress_percent: number;
  window_start: string | null;
  window_end: string | null;
}

export type StgCalendarKind = "window" | "delivery" | "worked";

export interface StgCalendarEntry {
  project_id: string;
  kind: StgCalendarKind;
  on_date: string | null;
  from_date: string | null;
  to_date: string | null;
  label: string | null;
}

export interface StgDayLog {
  headline: string | null;
  notes: string;
  day_flow: "smooth" | "fine" | "stuck" | null;
}

export interface StgDayPayload {
  worked: boolean;
  crew_names: string[];
  total_hours: number;
  units_finished: number;
  log: StgDayLog | null;
}

export async function stgJobList(): Promise<StgJob[]> {
  const { data, error } = await supabase.rpc("stg_job_list");
  if (isMissingFunction(error)) throw new Error("Partner access is not ready. Ask the office to finish the portal setup.");
  if (error) throw error;
  return (data ?? []) as StgJob[];
}

export async function stgCalendar(from: string, to: string): Promise<StgCalendarEntry[]> {
  const { data, error } = await supabase.rpc("stg_calendar", { p_from: from, p_to: to });
  if (isMissingFunction(error)) throw new Error("Partner access is not ready. Ask the office to finish the portal setup.");
  if (error) throw error;
  return (data ?? []) as StgCalendarEntry[];
}

const EMPTY_DAY: StgDayPayload = {
  worked: false,
  crew_names: [],
  total_hours: 0,
  units_finished: 0,
  log: null,
};

export async function stgDay(projectId: string, date: string): Promise<StgDayPayload> {
  const { data, error } = await supabase.rpc("stg_day", {
    p_project: projectId,
    p_date: date,
  });
  if (isMissingFunction(error)) throw new Error("Partner access is not ready. Ask the office to finish the portal setup.");
  if (error) throw error;
  return (data ?? EMPTY_DAY) as StgDayPayload;
}

/** Identify the shell through the server; never render crew chrome after a failed identity check. */
export function useIsPartnerUser() {
  return useQuery({
    queryKey: ["isPartnerUser"],
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc("is_partner_user");
      if (error) throw error;
      return Boolean(data);
    },
  });
}

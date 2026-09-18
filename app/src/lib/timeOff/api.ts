import { supabase } from "../supabase";
import { isMissingTable } from "../schemaErrors";
import type { TimeOffKind, TimeOffRequest } from "./model";
const SELECT =
  "id,profile_id,kind,start_date,end_date,status,created_at,reviewed_by,reviewed_at,profiles!profile_id(display_name)";
export async function listTimeOff(
  profileId?: string,
): Promise<TimeOffRequest[]> {
  const rows: TimeOffRequest[] = [];
  for (let page = 0; page < 1000; page++) {
    let q = supabase
      .from("time_off_requests")
      .select(SELECT)
      .order("start_date", { ascending: false })
      .order("id")
      .range(page * 1000, page * 1000 + 999);
    if (profileId) q = q.eq("profile_id", profileId);
    const { data, error } = await q;
    if (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }
    rows.push(...((data ?? []) as unknown as TimeOffRequest[]));
    if ((data?.length ?? 0) < 1000) return rows;
  }
  throw new Error(
    "There are too many time-off entries to load. Please contact your supervisor.",
  );
}
export async function requestTimeOff(
  id: string,
  kind: TimeOffKind,
  start: string,
  end: string,
) {
  const { error } = await supabase.rpc("request_time_off", {
    p_id: id,
    p_kind: kind,
    p_start: start,
    p_end: end,
  });
  if (error) throw error;
}
export async function reviewTimeOff(
  id: string,
  status: "approved" | "declined" | "canceled",
) {
  const { error } = await supabase.rpc("review_time_off", {
    p_id: id,
    p_status: status,
  });
  if (error) throw error;
}

export async function listCrewReminders(profileId: string) {
  const { data, error } = await supabase
    .from("crew_reminders")
    .select(
      "id,title,body,url,created_at,request_status,time_off_requests(status)",
    )
    .eq("profile_id", profileId)
    .is("shift_id", null)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []).filter((row) => {
    const request = row.time_off_requests as unknown as {
      status: string;
    } | null;
    return request?.status === row.request_status;
  }) as {
    id: string;
    title: string;
    body: string;
    url: string;
    created_at: string;
  }[];
}

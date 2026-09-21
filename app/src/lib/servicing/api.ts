import { supabase } from "../supabase";
import type {
  ServiceCommand,
  ServiceVisit,
  ServiceUnit,
  ServiceSession,
  ServiceMedia,
  ServiceSnapshot,
} from "./model";
async function rows<T>(
  table: string,
  select: string,
  visit?: string,
  person?: string,
): Promise<T[]> {
  const output: T[] = [];
  let expected: number | null = null;
  for (let offset = 0; offset < 1000000; ) {
    let query = supabase
      .from(table)
      .select(select, { count: "exact" })
      .order("id")
      .range(offset, offset + 499);
    if (visit) query = query.eq("visit_id", visit);
    if (person) query = query.eq("profile_id", person).is("ended_at", null);
    const { data, error, count } = await query;
    if (error) throw error;
    if (count === null || (expected !== null && expected !== count))
      throw new Error("Service records changed. Refresh before exporting.");
    expected = count;
    output.push(...(data as T[]));
    offset += data?.length ?? 0;
    if (offset === count) {
      if (new Set(output.map((x) => (x as { id: string }).id)).size !== count)
        throw new Error("Service records changed. Refresh.");
      return output;
    }
    if (!data?.length)
      throw new Error("Some service records did not load. Refresh.");
  }
  throw new Error("Choose fewer visits.");
}
const TIME =
  "*,profiles!profile_id(display_name),time_shifts!shift_id(clock_in_at,clock_out_at,break_seconds,status,project_id)";
export const listServiceVisits = () =>
  rows<ServiceVisit>("service_visits", "*");
export const listActiveService = (person: string) =>
  rows<ServiceSession>("service_time_sessions", TIME, undefined, person);
export async function getServiceVisit(id: string): Promise<ServiceSnapshot> {
  const { data: visit, error } = await supabase
    .from("service_visits")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  const [units, sessions, media, bounds] = await Promise.all([
    rows<ServiceUnit>("service_visit_units", "*", id),
    rows<ServiceSession>(
      "service_time_sessions",
      "*,profiles!profile_id(display_name)",
      id,
    ),
    rows<ServiceMedia>("service_media", "*", id),
    supabase.rpc("service_shift_bounds", { p_visit: id }),
  ]);
  const { data: check, error: changed } = await supabase
    .from("service_visits")
    .select("revision")
    .eq("id", id)
    .single();
  if (changed) throw changed;
  if (check.revision !== visit.revision)
    throw new Error(
      "This visit changed while loading. Refresh to see the latest report.",
    );
  if (bounds.error) throw bounds.error;
  return {
    visit: visit as ServiceVisit,
    units,
    sessions: sessions.map((s) => ({
      ...s,
      time_shifts: bounds.data?.[s.shift_id] ?? null,
    })),
    media,
  };
}
export async function sendServiceCommand(c: ServiceCommand): Promise<string> {
  const { data, error: authError } = await supabase.auth.getSession();
  if (authError) throw authError;
  if (data.session?.user.id !== c.userId)
    throw new Error(
      "Sign into the account that recorded this visit to sync it.",
    );
  const { data: result, error } = await supabase.rpc("service_command", {
    p_id: c.id,
    p_action: c.action,
    p_data: c.data,
  });
  if (error) throw error;
  return result as string;
}
export async function serviceMediaUrl(media: ServiceMedia): Promise<string> {
  const { data, error } = await supabase.storage
    .from("service-media")
    .createSignedUrl(media.storage_path, 3600);
  if (error) throw error;
  return data.signedUrl;
}
export async function serviceMediaBlob(
  media: Pick<ServiceMedia, "storage_path">,
  signal?: AbortSignal,
): Promise<Blob> {
  const { data, error } = await supabase.storage
    .from("service-media")
    .download(media.storage_path, undefined, { signal });
  if (error) throw error;
  return data;
}
export async function getServiceSupervisor(
  projectId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("service_job_supervisors")
    .select("profile_id")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  return data?.profile_id ?? null;
}

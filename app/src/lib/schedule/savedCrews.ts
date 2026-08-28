// Saved crews (wave A, A1): named teams (2-6 people) a supervisor builds on
// the Roster because they work well together. RPC-only writes — save_crew/
// delete_crew validate name, member count, and that members are active
// profiles server-side (supabase/migrations/20260955000000_saved_crews.sql)
// — so this module is a thin, un-degraded call-through, the same shape as
// listCapabilityBadges/setCapabilityBadge in lib/install/api.ts.
//
// The scheduling AI (wave A2) reads these through get_scheduling_picture and
// keeps one together as a soft law (CONTEXT.md: Saved crew) — this file is
// also where a human builds them in the first place.

import { supabase } from "../supabase";

export interface SavedCrew {
  id: string;
  name: string;
  member_ids: string[];
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function listSavedCrews(): Promise<SavedCrew[]> {
  const { data, error } = await supabase
    .from("saved_crews")
    .select("id, name, member_ids, note, created_by, created_at, updated_at")
    .order("name");
  if (error) throw error;
  return (data ?? []) as SavedCrew[];
}

export interface SaveCrewInput {
  /** Omit (or null) to create a new crew; pass an id to rename/reshuffle one. */
  id?: string | null;
  name: string;
  memberIds: string[];
  note?: string | null;
}

export async function saveCrew(input: SaveCrewInput): Promise<SavedCrew> {
  const { data, error } = await supabase.rpc("save_crew", {
    p_id: input.id ?? null,
    p_name: input.name,
    p_members: input.memberIds,
    p_note: input.note ?? null,
  });
  if (error) throw error;
  return data as SavedCrew;
}

export async function deleteCrew(id: string): Promise<void> {
  const { error } = await supabase.rpc("delete_crew", { p_id: id });
  if (error) throw error;
}

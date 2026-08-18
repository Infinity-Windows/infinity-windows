// Takeoffs (owner spec + grill, 2026-08-18): a warehouse hand bundles a
// job's supplies for a named person. See 20260917000000_takeoffs.sql for the
// flow; this file is the client half — reads, writes, and the words.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import type { Supply } from "./ops";

export type TakeoffStatus = "requested" | "acknowledged" | "ready" | "picked_up";
export type TakeoffEta = "30min" | "today" | "tomorrow" | "this_week";

export interface Takeoff {
  id: string;
  project_id: string;
  for_profile_id: string | null;
  created_by: string | null;
  status: TakeoffStatus;
  note: string | null;
  eta: TakeoffEta | null;
  eta_note: string | null;
  created_at: string;
  acknowledged_at: string | null;
  ready_at: string | null;
  picked_up_at: string | null;
  picked_up_by: string | null;
  takeoff_items?: { id: string; supply_id: string; qty: number }[];
}

export const ETA_LABELS: Record<TakeoffEta, string> = {
  "30min": "about 30 minutes",
  today: "later today",
  tomorrow: "tomorrow",
  this_week: "this week",
};

export const TAKEOFF_STATUS_LABELS: Record<TakeoffStatus, string> = {
  requested: "Requested",
  acknowledged: "In the works",
  ready: "Ready for pickup",
  picked_up: "Picked up",
};

/** The one-line story of where a takeoff stands, for its row. */
export function takeoffStatusLine(t: Takeoff): string {
  switch (t.status) {
    case "requested":
      return "Requested — waiting on the warehouse";
    case "acknowledged":
      return t.eta
        ? `In the works — ${ETA_LABELS[t.eta]}${t.eta_note ? ` (${t.eta_note})` : ""}`
        : "In the works";
    case "ready":
      return "Ready for pickup";
    case "picked_up":
      return "Picked up — supplies are on the job's tab";
  }
}

/**
 * Lines short of the shelf, for the warn-never-block banner (standing
 * decision): "Caulk — wants 12, about 8 on hand". Uncounted supplies say so
 * instead of pretending.
 */
export function shortageLines(
  items: { supply_id: string; qty: number }[],
  supplies: Supply[],
): string[] {
  const byId = new Map(supplies.map((s) => [s.id, s]));
  const out: string[] = [];
  for (const it of items) {
    const s = byId.get(it.supply_id);
    if (!s) continue;
    if (s.on_hand == null) {
      out.push(`${s.name} — never counted, so nobody knows if ${it.qty} is there`);
    } else if (s.on_hand < it.qty) {
      out.push(`${s.name} — wants ${it.qty}, about ${s.on_hand} on hand`);
    }
  }
  return out;
}

const SELECT = "*, takeoff_items(id, supply_id, qty)";

export async function listTakeoffs(): Promise<Takeoff[]> {
  const { data, error } = await supabase
    .from("takeoffs")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingTable(error, "takeoffs")) return [];
    throw error;
  }
  return (data ?? []) as Takeoff[];
}

export async function createTakeoff(input: {
  projectId: string;
  forProfileId: string | null;
  items: { supply_id: string; qty: number }[];
  note?: string | null;
  ready: boolean;
}): Promise<Takeoff> {
  const { data, error } = await supabase.rpc("create_takeoff", {
    p_project: input.projectId,
    p_for: input.forProfileId,
    p_items: input.items,
    p_note: input.note ?? null,
    p_ready: input.ready,
  });
  if (error) throw error;
  return data as Takeoff;
}

export async function acknowledgeTakeoff(input: {
  takeoffId: string;
  eta: TakeoffEta | null;
  etaNote?: string | null;
}): Promise<Takeoff> {
  const { data, error } = await supabase.rpc("acknowledge_takeoff", {
    p_takeoff: input.takeoffId,
    p_eta: input.eta,
    p_eta_note: input.etaNote ?? null,
  });
  if (error) throw error;
  return data as Takeoff;
}

export async function readyTakeoff(takeoffId: string): Promise<Takeoff> {
  const { data, error } = await supabase.rpc("ready_takeoff", { p_takeoff: takeoffId });
  if (error) throw error;
  return data as Takeoff;
}

export async function pickupTakeoff(takeoffId: string): Promise<Takeoff> {
  const { data, error } = await supabase.rpc("pickup_takeoff", { p_takeoff: takeoffId });
  if (error) throw error;
  return data as Takeoff;
}

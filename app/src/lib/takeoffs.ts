// Takeoffs (owner spec + grill, 2026-08-18): a warehouse hand bundles a
// job's supplies for a named person. See 20260917000000_takeoffs.sql for the
// flow; this file is the client half — reads, writes, and the words.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";
import type { Supply } from "./ops";
import { CATALOG, type TKey } from "./i18n/catalog";
import { translate, type Lang } from "./i18n/translate";
import type { TFn } from "./i18n/context";

// Only Takeoffs.tsx reads the label/line helpers below (Warehouse.tsx, the
// other importer of this module, only reads listTakeoffs — no strings), so
// they carry `t` straight through with no other-screen carve-out to worry
// about. `t` defaults to English so takeoffs.test.ts needs no changes.
const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

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

/** Every ETA a person can pick, in the order the buttons show them. */
export const ETA_ORDER: TakeoffEta[] = ["30min", "today", "tomorrow", "this_week"];

const ETA_LABEL_KEY: Record<TakeoffEta, TKey> = {
  "30min": "takeoffs.eta.thirtyMin",
  today: "takeoffs.eta.today",
  tomorrow: "takeoffs.eta.tomorrow",
  this_week: "takeoffs.eta.thisWeek",
};

/** "about 30 minutes" / "later today" / … — the rough-when a person picks. */
export function etaLabel(eta: TakeoffEta, t: TFn = englishT): string {
  return t(ETA_LABEL_KEY[eta]);
}

const TAKEOFF_STATUS_LABEL_KEY: Record<TakeoffStatus, TKey> = {
  requested: "takeoffs.status.requested",
  acknowledged: "takeoffs.status.acknowledged",
  ready: "takeoffs.status.ready",
  picked_up: "takeoffs.status.pickedUp",
};

/** "Requested" / "In the works" / "Ready for pickup" / "Picked up". */
export function takeoffStatusLabel(status: TakeoffStatus, t: TFn = englishT): string {
  return t(TAKEOFF_STATUS_LABEL_KEY[status]);
}

/** The one-line story of where a takeoff stands, for its row. */
export function takeoffStatusLine(takeoff: Takeoff, t: TFn = englishT): string {
  switch (takeoff.status) {
    case "requested":
      return t("takeoffs.line.requested");
    case "acknowledged":
      return takeoff.eta
        ? t("takeoffs.line.acknowledgedEta", {
            eta: etaLabel(takeoff.eta, t),
            note: takeoff.eta_note ? t("takeoffs.line.etaNote", { note: takeoff.eta_note }) : "",
          })
        : t("takeoffs.line.acknowledged");
    case "ready":
      return t("takeoffs.line.ready");
    case "picked_up":
      return t("takeoffs.line.pickedUp");
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
  t: TFn = englishT,
): string[] {
  const byId = new Map(supplies.map((s) => [s.id, s]));
  const out: string[] = [];
  for (const it of items) {
    const s = byId.get(it.supply_id);
    if (!s) continue;
    if (s.on_hand == null) {
      out.push(t("takeoffs.shortage.neverCounted", { name: s.name, qty: it.qty }));
    } else if (s.on_hand < it.qty) {
      out.push(t("takeoffs.shortage.wantsHas", { name: s.name, qty: it.qty, onHand: s.on_hand }));
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

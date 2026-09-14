import { supabase } from "./supabase";
import { isMissingFunction } from "./schemaErrors";

export const WAREHOUSE_CAPABILITIES = [
  ["receive", "Receive material"], ["tag", "Prepare labels"], ["move", "Move, return and stage"],
  ["checkout", "Checkout / send to site"], ["arrival", "Confirm arrivals"], ["damage", "Report damage"],
  ["supplies", "Take job supplies"], ["containers", "Create and move job containers"], ["deliveries", "Create and update job deliveries"], ["finalize", "Finalize / reopen materials"], ["undo", "Undo own recent movements"],
] as const;
export type WarehouseCapability = typeof WAREHOUSE_CAPABILITIES[number][0];
export type WarehouseAction = WarehouseCapability | "bind" | "stage" | "reopen" | "container_create" | "container_move" | "delivery_create" | "delivery_update";
export interface PartnerPackage {
  id: string; serial: string; short_code: string | null; project_id: string;
  status: string; container_id: string | null; location_id: string | null; version: string | null;
  mark: string | null; part_type: string | null; part_index: number | null; part_total: number | null;
  area: string | null; delivery_id: string | null;
}
export interface PartnerWarehouse {
  capabilities: WarehouseCapability[]; finalized_at: string | null;
  packages: PartnerPackage[];
  containers: { id: string; serial: string; name: string; kind: string; active: boolean; parent_container_id: string | null }[];
  deliveries: { id: string; label: string; expected_at: string | null; shared: boolean }[];
  supplies: { id: string; name: string; unit: string }[];
  history: { id: string; package_id: string | null; event: string; created_at: string }[];
  undoable: { id: string; action: string; created_at: string }[];
}
export interface WarehouseCommand {
  id: string; project: string; action: WarehouseAction; input: Record<string, unknown>;
}
export async function partnerWarehouse(project: string): Promise<PartnerWarehouse> {
  const { data, error } = await supabase.rpc("stg_warehouse", { p_project: project });
  if (isMissingFunction(error)) throw new Error("Warehouse access is not ready. Ask the office to finish the portal setup.");
  if (error) throw error;
  if (!data) throw new Error("Warehouse access is not ready. Ask the office to finish the portal setup.");
  return data as PartnerWarehouse;
}
export async function sendWarehouseCommand(command: WarehouseCommand): Promise<{ command: string; count: number }> {
  const { data, error } = await supabase.rpc("stg_warehouse_command", {
    p_command: command.id, p_project: command.project, p_action: command.action, p_input: command.input,
  });
  if (isMissingFunction(error)) throw new Error("Warehouse actions are not ready. Ask the office to finish the portal setup.");
  if (error) throw error;
  return data as { command: string; count: number };
}
export function packageCommand(project: string, action: WarehouseAction, packages: PartnerPackage[], extra: Record<string, unknown> = {}): WarehouseCommand {
  return {
    id: crypto.randomUUID(), project, action,
    input: { ...extra, packages: packages.map(p => p.id), expected: Object.fromEntries(packages.map(p => [p.id, {
      status: p.status, container_id: p.container_id, location_id: p.location_id, version: p.version,
    }])) },
  };
}
export async function listWarehousePermissions(): Promise<{ partner_profile_id: string; capabilities: WarehouseCapability[] }[]> {
  const { data, error } = await supabase.from("partner_warehouse_permissions").select("partner_profile_id, capabilities");
  if (error) throw error;
  return data ?? [];
}
export async function setWarehousePermissions(partner: string, capabilities: WarehouseCapability[]): Promise<void> {
  const { error } = await supabase.rpc("set_partner_warehouse_permissions", { p_partner: partner, p_capabilities: capabilities });
  if (error) throw error;
}

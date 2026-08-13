// Storage tracking: conex containers + license-plate packages.
//
// The receiving flow this serves (owner spec, 2026-08-13): pre-printed
// anonymous QR stickers bind to packages as they come off the delivery
// truck (job + category + optional marks), packages check in to containers
// by multi-select (no camera per package), installers check them out with a
// reason + destination job. Checkout concludes tracking; a transfer to
// another container re-stores instead.
//
// Every write goes through a SECURITY DEFINER RPC (see the storage_tracking
// migration) — never insert/update these tables directly; the tables have
// no direct-write policies at all.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";

export type PackageStatus = "blank" | "received" | "stored" | "checked_out";
export type PackageCategory = "windows" | "doors" | "frames" | "hardware" | "other";

export const CATEGORY_LABELS: Record<PackageCategory, string> = {
  windows: "Windows",
  doors: "Doors",
  frames: "Frames",
  hardware: "Hardware",
  other: "Other",
};

export interface StorageContainer {
  id: string;
  serial: string;
  name: string;
  address: string | null;
  access_code: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
}

export interface StoragePackage {
  id: string;
  serial: string;
  short_code: string | null;
  status: PackageStatus;
  project_id: string | null;
  category: PackageCategory | null;
  note: string | null;
  delivery_id: string | null;
  container_id: string | null;
  bound_at: string | null;
  bound_by: string | null;
  created_at: string;
  /** Joined-in list of mark codes riding inside, when requested. */
  package_marks?: { mark_code: string }[];
}

export interface PackageEvent {
  id: string;
  package_id: string;
  event: "bound" | "stored" | "moved" | "checked_out";
  container_id: string | null;
  project_id: string | null;
  reason: string | null;
  actor: string | null;
  created_at: string;
}

export interface CheckoutReason {
  id: string;
  label: string;
  sort: number;
  active: boolean;
}

export interface PackageDelivery {
  id: string;
  label: string;
  arrived_on: string;
}

const PACKAGE_SELECT = "*, package_marks(mark_code)";

// ---------------------------------------------------------------- reads

export async function listContainers(): Promise<StorageContainer[]> {
  const { data, error } = await supabase
    .from("storage_containers")
    .select("*")
    .eq("active", true)
    .order("name");
  if (error) {
    if (isMissingTable(error, "storage_containers")) return [];
    throw error;
  }
  return (data ?? []) as StorageContainer[];
}

/** Every non-blank package — the hub search and container manifests slice it. */
export async function listActivePackages(): Promise<StoragePackage[]> {
  const { data, error } = await supabase
    .from("packages")
    .select(PACKAGE_SELECT)
    .neq("status", "blank")
    .order("bound_at", { ascending: false });
  if (error) {
    if (isMissingTable(error, "packages")) return [];
    throw error;
  }
  return (data ?? []) as StoragePackage[];
}

export async function listBlankPackages(): Promise<StoragePackage[]> {
  const { data, error } = await supabase
    .from("packages")
    .select("*")
    .eq("status", "blank")
    .order("serial");
  if (error) {
    if (isMissingTable(error, "packages")) return [];
    throw error;
  }
  return (data ?? []) as StoragePackage[];
}

export async function getPackageBySerial(serial: string): Promise<StoragePackage | null> {
  const { data, error } = await supabase
    .from("packages")
    .select(PACKAGE_SELECT)
    .eq("serial", serial.toUpperCase())
    .maybeSingle();
  if (error) {
    if (isMissingTable(error, "packages")) return null;
    throw error;
  }
  return (data as StoragePackage) ?? null;
}

export async function getPackageByShortCode(code: string): Promise<StoragePackage | null> {
  const { data, error } = await supabase
    .from("packages")
    .select(PACKAGE_SELECT)
    .eq("short_code", code.toUpperCase())
    .maybeSingle();
  if (error) throw error;
  return (data as StoragePackage) ?? null;
}

export async function getContainerBySerial(serial: string): Promise<StorageContainer | null> {
  const { data, error } = await supabase
    .from("storage_containers")
    .select("*")
    .eq("serial", serial.toUpperCase())
    .maybeSingle();
  if (error) {
    if (isMissingTable(error, "storage_containers")) return null;
    throw error;
  }
  return (data as StorageContainer) ?? null;
}

export async function listPackageEvents(packageId: string): Promise<PackageEvent[]> {
  const { data, error } = await supabase
    .from("package_events")
    .select("*")
    .eq("package_id", packageId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as PackageEvent[];
}

export async function listCheckoutReasons(): Promise<CheckoutReason[]> {
  const { data, error } = await supabase
    .from("checkout_reasons")
    .select("*")
    .eq("active", true)
    .order("sort");
  if (error) {
    if (isMissingTable(error, "checkout_reasons")) return [];
    throw error;
  }
  return (data ?? []) as CheckoutReason[];
}

// ---------------------------------------------------------------- writes (RPC only)

export async function mintPackages(count: number): Promise<StoragePackage[]> {
  const { data, error } = await supabase.rpc("mint_packages", { p_count: count });
  if (error) throw error;
  return (data ?? []) as StoragePackage[];
}

export async function saveContainer(input: {
  id?: string | null;
  name: string;
  address?: string | null;
  accessCode?: string | null;
  notes?: string | null;
  active?: boolean;
}): Promise<StorageContainer> {
  const { data, error } = await supabase.rpc("save_storage_container", {
    p_id: input.id ?? null,
    p_name: input.name,
    p_address: input.address ?? null,
    p_access_code: input.accessCode ?? null,
    p_notes: input.notes ?? null,
    p_active: input.active ?? true,
  });
  if (error) throw error;
  return data as StorageContainer;
}

export async function ensureDelivery(label: string): Promise<PackageDelivery> {
  const { data, error } = await supabase.rpc("ensure_package_delivery", {
    p_label: label,
  });
  if (error) throw error;
  return data as PackageDelivery;
}

export async function bindPackage(input: {
  packageId: string;
  projectId: string;
  category?: PackageCategory | null;
  note?: string | null;
  marks?: string[];
  deliveryId?: string | null;
}): Promise<StoragePackage> {
  const { data, error } = await supabase.rpc("bind_package", {
    p_package: input.packageId,
    p_project: input.projectId,
    p_category: input.category ?? null,
    p_note: input.note ?? null,
    p_marks: input.marks ?? null,
    p_delivery: input.deliveryId ?? null,
  });
  if (error) throw error;
  return data as StoragePackage;
}

export async function storePackages(packageIds: string[], containerId: string): Promise<number> {
  const { data, error } = await supabase.rpc("store_packages", {
    p_packages: packageIds,
    p_container: containerId,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

export async function checkoutPackages(
  packageIds: string[],
  reason: string,
  projectId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("checkout_packages", {
    p_packages: packageIds,
    p_reason: reason,
    p_project: projectId,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

// ---------------------------------------------------------------- pure helpers

export interface JobGroup<T> {
  projectId: string | null;
  packages: T[];
}

/** Manifest grouping: packages by job, biggest group first, unbound last. */
export function groupByJob<T extends { project_id: string | null }>(
  packages: T[],
): JobGroup<T>[] {
  const byJob = new Map<string | null, T[]>();
  for (const p of packages) {
    const key = p.project_id;
    const list = byJob.get(key);
    if (list) list.push(p);
    else byJob.set(key, [p]);
  }
  return [...byJob.entries()]
    .map(([projectId, list]) => ({ projectId, packages: list }))
    .sort((a, b) => {
      if (a.projectId === null) return 1;
      if (b.projectId === null) return -1;
      return b.packages.length - a.packages.length;
    });
}

/** Whole days a package has been sitting since it was bound. */
export function agingDays(boundAt: string | null | undefined, now: Date): number | null {
  if (!boundAt) return null;
  const t = Date.parse(boundAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/**
 * The mismatch guard: packages whose BOUND job differs from the checkout's
 * destination job — a crate labeled PECAN leaving under BLACK22 deserves an
 * amber warning before submit.
 */
export function mismatchedPackages<T extends { project_id: string | null }>(
  packages: T[],
  destinationProjectId: string,
): T[] {
  return packages.filter(
    (p) => p.project_id != null && p.project_id !== destinationProjectId,
  );
}

/** "Delivery Aug 14" — the default label for today's truck. */
export function defaultDeliveryLabel(now: Date): string {
  return `Delivery ${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

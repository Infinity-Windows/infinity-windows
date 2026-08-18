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
import { isMissingColumn, isMissingFunction, isMissingTable } from "./schemaErrors";

export type PackageStatus = "blank" | "received" | "stored" | "checked_out";
export type PackageCategory = "windows" | "doors" | "frames" | "hardware" | "other";

export const CATEGORY_LABELS: Record<PackageCategory, string> = {
  windows: "Windows",
  doors: "Doors",
  frames: "Frames",
  hardware: "Hardware",
  other: "Other",
};

/** Which piece of the window this package is — the grill's fixed list (Q17). */
export type PartType =
  | "frame"
  | "glass"
  | "panel"
  | "threshold"
  | "hardware"
  | "screen"
  | "other";

export const PART_TYPES: PartType[] = [
  "frame",
  "glass",
  "panel",
  "threshold",
  "hardware",
  "screen",
  "other",
];

export const PART_LABELS: Record<PartType, string> = {
  frame: "Frame",
  glass: "Glass",
  panel: "Panel / sash",
  threshold: "Threshold",
  hardware: "Hardware",
  screen: "Screen",
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
  /** The container this one sits inside (a crate in a conex) — one level max.
   * Optional: rows read before the nesting migration lack the keys. */
  parent_container_id?: string | null;
  /** A recorded spot for a container that sits on its own. */
  location_id?: string | null;
  /** What kind of box: conex | crate | truck | building. Rows read before the
   * kinds migration lack it — treat missing as a conex, which is what every
   * pre-kind container actually was. */
  kind?: string | null;
  /** A crate's measurements — some fit in no conex, and a forklift needs the
   * weight. Null means "not measured", never zero. */
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  weight_kg?: number | null;
}

/** The kind of a container, defaulting missing/unknown rows to conex. */
export function containerKind(c: Pick<StorageContainer, "kind"> | null | undefined): string {
  return c?.kind ?? "conex";
}

export interface StoragePackage {
  id: string;
  serial: string;
  short_code: string | null;
  status: PackageStatus;
  project_id: string | null;
  category: PackageCategory | null;
  /** "#16 2/3" → 2. Null/absent when the label carries no part number.
   * Optional because rows read from a database the part-fields migration
   * hasn't reached yet simply lack the keys. */
  part_index?: number | null;
  /** "#16 2/3" → 3 — how many pieces the whole unit ships as. */
  part_total?: number | null;
  part_type?: PartType | null;
  /** The manufacturer's own mark, only when it differs from the plan mark. */
  mfr_mark?: string | null;
  note: string | null;
  delivery_id: string | null;
  container_id: string | null;
  /** A rack slot for a package sitting loose outside any container. Neither
   * this nor container_id set = LOOSE, the cannot-find-it pile. Optional:
   * pre-migration rows lack the key. */
  location_id?: string | null;
  bound_at: string | null;
  bound_by: string | null;
  created_at: string;
  /** Joined-in list of mark codes riding inside, when requested. */
  package_marks?: { mark_code: string }[];
}

/**
 * A package_marks row as the database returns it, in either era. Before the
 * project_marks migration the row carried the code itself; after it, the code
 * lives on the joined mark row. Both normalize to the flat `{ mark_code }`
 * shape the pages consume, so no screen knows the schema moved under it.
 */
export interface RawPackageMark {
  mark_code?: string | null;
  mark?: { mark_code: string } | null;
}

/** Flatten either era's mark rows to the public shape. Exported for tests. */
export function normalizeMarks(
  rows: RawPackageMark[] | null | undefined,
): { mark_code: string }[] {
  const out: { mark_code: string }[] = [];
  for (const r of rows ?? []) {
    const code = r.mark?.mark_code ?? r.mark_code;
    if (code) out.push({ mark_code: code });
  }
  return out;
}

function normalizePackage(row: Record<string, unknown>): StoragePackage {
  const pkg = row as unknown as StoragePackage & { package_marks?: RawPackageMark[] };
  return { ...pkg, package_marks: normalizeMarks(pkg.package_marks) };
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

/** A movements row, as far as the package timeline needs it (ticket 05). */
export interface MovementRow {
  id: string;
  package_id: string | null;
  event: string;
  from_container_id?: string | null;
  to_container_id?: string | null;
  project_id: string | null;
  reason: string | null;
  actor: string | null;
  created_at: string;
}

/**
 * A movements row read back in the package timeline's shape. The old log's
 * container_id meant "destination" on store/move and "source" on checkout —
 * `to ?? from` reproduces exactly that, so the sheet's copy never shifts.
 * Exported for tests.
 */
export function movementToPackageEvent(m: MovementRow): PackageEvent {
  return {
    id: m.id,
    package_id: m.package_id ?? "",
    event: m.event as PackageEvent["event"],
    container_id: m.to_container_id ?? m.from_container_id ?? null,
    project_id: m.project_id,
    reason: m.reason,
    actor: m.actor,
    created_at: m.created_at,
  };
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

// Marks join through project_marks now (ticket 01); the legacy select is the
// fallback for a database the migration hasn't reached yet. Once it lands
// everywhere, the fallback and RawPackageMark's `mark_code` field can go.
const PACKAGE_SELECT = "*, package_marks(mark:project_marks(mark_code))";
const LEGACY_PACKAGE_SELECT = "*, package_marks(mark_code)";

/**
 * Run a package read with the new select, falling back to the legacy shape
 * when the database predates project_marks. PostgREST reports the unknown
 * join as a missing-relationship error naming the table, which is what
 * isMissingTable matches on. Returns the raw result either way — callers keep
 * their own error handling (missing `packages` still degrades to empty).
 */
async function withMarkJoin(
  // `data: unknown` on purpose: the select string is dynamic, so supabase-js
  // cannot type the rows anyway — normalizePackage is the one boundary where
  // the shape is asserted.
  run: (select: string) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ data: unknown; error: unknown }> {
  const first = await run(PACKAGE_SELECT);
  if (!first.error || !isMissingTable(first.error, "project_marks")) return first;
  return run(LEGACY_PACKAGE_SELECT);
}

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
  const { data, error } = await withMarkJoin((select) =>
    supabase
      .from("packages")
      .select(select)
      .neq("status", "blank")
      .order("bound_at", { ascending: false }),
  );
  if (error) {
    if (isMissingTable(error, "packages")) return [];
    throw error;
  }
  return ((data ?? []) as Record<string, unknown>[]).map(normalizePackage);
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
  const { data, error } = await withMarkJoin((select) =>
    supabase
      .from("packages")
      .select(select)
      .eq("serial", serial.toUpperCase())
      .maybeSingle(),
  );
  if (error) {
    if (isMissingTable(error, "packages")) return null;
    throw error;
  }
  return data ? normalizePackage(data as Record<string, unknown>) : null;
}

export async function getPackageByShortCode(code: string): Promise<StoragePackage | null> {
  const { data, error } = await withMarkJoin((select) =>
    supabase
      .from("packages")
      .select(select)
      .eq("short_code", code.toUpperCase())
      .maybeSingle(),
  );
  if (error) throw error;
  return data ? normalizePackage(data as Record<string, unknown>) : null;
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
  // One log now: the package's timeline is its movements rows (ticket 05).
  const modern = await supabase
    .from("movements")
    .select("*")
    .eq("package_id", packageId)
    .order("created_at", { ascending: false });
  if (!modern.error) {
    return ((modern.data ?? []) as MovementRow[]).map(movementToPackageEvent);
  }
  // Deploy window: a database that predates the fold-in has no package_id on
  // movements — the old table is still there, so read it as before.
  if (
    !isMissingColumn(modern.error, "package_id") &&
    !isMissingTable(modern.error, "movements")
  ) {
    throw modern.error;
  }
  const legacy = await supabase
    .from("package_events")
    .select("*")
    .eq("package_id", packageId)
    .order("created_at", { ascending: false });
  if (legacy.error) throw legacy.error;
  return (legacy.data ?? []) as PackageEvent[];
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
  /** Set at creation only; the server ignores it on an update — a crate that
   * "becomes" a conex is really a new box. */
  kind?: string | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  weightKg?: number | null;
}): Promise<StorageContainer> {
  const { data, error } = await supabase.rpc("save_storage_container", {
    p_id: input.id ?? null,
    p_name: input.name,
    p_address: input.address ?? null,
    p_access_code: input.accessCode ?? null,
    p_notes: input.notes ?? null,
    p_active: input.active ?? true,
    p_kind: input.kind ?? null,
    p_length_cm: input.lengthCm ?? null,
    p_width_cm: input.widthCm ?? null,
    p_height_cm: input.heightCm ?? null,
    p_weight_kg: input.weightKg ?? null,
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
  partIndex?: number | null;
  partTotal?: number | null;
  partType?: PartType | null;
  mfrMark?: string | null;
}): Promise<StoragePackage> {
  const base = {
    p_package: input.packageId,
    p_project: input.projectId,
    p_category: input.category ?? null,
    p_note: input.note ?? null,
    p_marks: input.marks ?? null,
    p_delivery: input.deliveryId ?? null,
  };
  const hasParts =
    input.partIndex != null ||
    input.partTotal != null ||
    input.partType != null ||
    Boolean(input.mfrMark?.trim());

  const { data, error } = await supabase.rpc("bind_package", {
    ...base,
    p_part_index: input.partIndex ?? null,
    p_part_total: input.partTotal ?? null,
    p_part_type: input.partType ?? null,
    p_mfr_mark: input.mfrMark ?? null,
  });
  if (!error) return data as StoragePackage;

  // Deploy window: the database still has the old 6-arg signature. Retrying
  // without the part fields is only safe when there are none to lose — a tag
  // WITH part data must fail loudly rather than silently shed it.
  if (isMissingFunction(error) && !hasParts) {
    const legacy = await supabase.rpc("bind_package", base);
    if (legacy.error) throw legacy.error;
    return legacy.data as StoragePackage;
  }
  throw error;
}

export async function storePackages(packageIds: string[], containerId: string): Promise<number> {
  const { data, error } = await supabase.rpc("store_packages", {
    p_packages: packageIds,
    p_container: containerId,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * Relocate a container — into another container (a crate into a conex), or
 * out on its own. Everything inside moves by inheritance; the server writes
 * the ride-along history. One level only; the database enforces it.
 */
export async function moveContainer(input: {
  containerId: string;
  parentContainerId?: string | null;
  locationId?: string | null;
}): Promise<StorageContainer> {
  const { data, error } = await supabase.rpc("move_container", {
    p_container: input.containerId,
    p_parent: input.parentContainerId ?? null,
    p_location: input.locationId ?? null,
  });
  if (error) throw error;
  return data as StorageContainer;
}

/**
 * Set packages aside on the job's staging bay so they go out together.
 *
 * Reversible: checking one back into a conex just re-stores it. Throws with
 * the `no_staging_bay` hint when the job has no bay — the server refuses
 * rather than falling back to a shared stock shelf, because material staged
 * on a shared shelf gets installed at the wrong address.
 */
export async function stagePackages(
  packageIds: string[],
  projectId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("stage_packages", {
    p_packages: packageIds,
    p_project: projectId,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * The jobsite half of load-out: confirm what actually turned up, and flag
 * what turned up broken. Not a required step and not a status change — it
 * exists for the one thing arrival adds, which is catching transit damage
 * while somebody is standing in front of it. Damaged packages open a deduped
 * urgent issue naming the package.
 */
export async function arrivePackages(input: {
  okIds: string[];
  damagedIds: string[];
  projectId: string;
  note?: string | null;
}): Promise<number> {
  const { data, error } = await supabase.rpc("arrive_packages", {
    p_ok: input.okIds,
    p_damaged: input.damagedIds,
    p_project: input.projectId,
    p_note: input.note ?? null,
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

/** Enough of a package to describe which piece it is. */
export interface PartLike {
  part_index?: number | null;
  part_total?: number | null;
  part_type?: PartType | null;
}

/**
 * Did the label carry a part number? Without one the package is treated as
 * 1 of 1 everywhere downstream — and FLAGGED, never silently upgraded to
 * knowledge nobody actually had (CONTEXT.md: completeness is read off the
 * labels, never assumed).
 */
export function hasPartNumber(p: PartLike): boolean {
  return p.part_index != null && p.part_total != null;
}

/**
 * "Part 2 of 3 · Glass", "Part 2 of 3", "Glass" — or null when the label
 * said nothing at all (callers show the "no part number" flag instead).
 */
export function partLabel(p: PartLike): string | null {
  const num = hasPartNumber(p) ? `Part ${p.part_index} of ${p.part_total}` : null;
  const kind = p.part_type ? PART_LABELS[p.part_type] : null;
  if (num && kind) return `${num} · ${kind}`;
  return num ?? kind;
}

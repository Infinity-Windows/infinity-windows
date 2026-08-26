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
import { signedMedia } from "./photos";

// minted: a pre-bound label for material that has not arrived (ticket 15).
// It can be found, printed and burned — and nothing else. Every door that
// moves a package (store, stage, check out) names its statuses explicitly and
// leaves minted out, so "you cannot store what has not arrived" costs nothing.
export type PackageStatus = "blank" | "minted" | "received" | "stored" | "checked_out";
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
  /** The container's 3D shell in Studio, when one has been made (ticket 22). */
  studio_project_id?: string | null;
}

/**
 * The words for who owns a package (ticket 17). Null project on a BOUND
 * package is the Boneyard — company stock, on purpose. A blank sticker owns
 * nothing yet, and a package whose job just isn't in the map (a finished job
 * filtered out of an active-jobs list) shows its absence honestly instead of
 * being adopted by the Boneyard — audit F9 is one rename away otherwise.
 */
export function jobLabel(
  p: Pick<StoragePackage, "project_id" | "status">,
  jobCodeById: Map<string, string>,
): string {
  if (p.status === "blank") return "";
  if (p.project_id == null) return "Boneyard";
  return jobCodeById.get(p.project_id) ?? "job not listed";
}

/** The kind of a container, defaulting missing/unknown rows to conex. */
export function containerKind(c: Pick<StorageContainer, "kind"> | null | undefined): string {
  return c?.kind ?? "conex";
}

/**
 * A container's color-badge hue (pick 5, W2): no zone/color column exists on
 * storage_containers, and this wave adds none — the badge is derived from the
 * serial instead, on the fly, every time it is shown. A plain char-code hash
 * into one of 6 evenly spaced oklch hues, so the same serial always lands on
 * the same badge everywhere it appears, in both themes (the CSS token pair
 * this feeds carries the theme; the hue itself never changes).
 *
 * The badge is decorative, never load-bearing, so a row read from an older
 * database column set (or a test fixture that never set one) gets a color
 * rather than a crashed page — `String()` turns a missing/non-string serial
 * into "" instead of throwing on `.length`.
 */
export function containerHue(serial: string): number {
  const s = String(serial ?? "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  const HUES = [0, 60, 120, 180, 240, 300];
  return HUES[Math.abs(hash) % HUES.length];
}

/**
 * Where a poster scan should land once ContainerDetail has the container in
 * hand (pick 31, "poster QR opens the living container"): straight into the
 * 3D shell when one exists — a shell IS the living container — or null to
 * stay right there on the plain manifest, which already shows contents on
 * its own.
 *
 * Gated on `from === "poster"` rather than firing for every visit: reaching
 * the page any other way (the warehouse grid, Find, a package's "back to
 * its container") means somebody picked this container on purpose and the
 * manifest is what they asked to see, not a bounce straight past it.
 */
export function posterAutoOpenPath(
  container: Pick<StorageContainer, "id" | "studio_project_id"> | null,
  from: string | null,
): string | null {
  if (from !== "poster" || !container?.studio_project_id) return null;
  return `/warehouse/3d/${container.id}`;
}

export interface StoragePackage {
  /** Crate contents: pieces riding inside for this mark (null on 1-of-N packages). */
  piece_count?: number | null;
  /** Job name typed at the truck when the job isn't built in the app yet. */
  pending_job_name?: string | null;
  /** Where inside its current box: front/middle/back, or a compass point in
   * the building. Cleared by the database the moment the package changes
   * places — a pointer, not a place (ADR-0006). */
  area?: string | null;
  /** What the maker's own printed label says the window ships as, when
   * somebody at the truck saw it disagree with ours (ticket 20). The maker
   * wins the argument; this is the argument, on the record. */
  mfr_part_total?: number | null;
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
  part_type?: string | null;
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
  /** `actor` resolved to a display name — a second lookup by id, the same
   * pattern ops.ts's listSupplyTakes uses, since movements.actor is plain
   * text (auth.uid()) with no declared FK for PostgREST to embed. Null when
   * the id can't be resolved (deleted profile); listPackageEvents fills this
   * in after the fact, so movementToPackageEvent itself never sets it. */
  actor_name: string | null;
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
    // Filled in by listPackageEvents, which has the batch profile lookup
    // this bare mapper doesn't — and shouldn't, it stays a pure row shape.
    actor_name: null,
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

/**
 * Batch-resolve actor ids to display names — the same two-query pattern
 * ops.ts's listSupplyTakes uses. movements.actor is plain text (auth.uid()),
 * not a declared FK to profiles.id, so PostgREST has no join to embed and a
 * second query does the lookup instead. An id that can't be resolved (a
 * deleted profile) is simply absent from the map; callers fall back to the
 * raw actor value, same as Supplies.tsx does.
 */
async function resolveActorNames(actorIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(actorIds.filter((a): a is string => Boolean(a)))];
  const nameById = new Map<string, string>();
  if (ids.length === 0) return nameById;
  const { data, error } = await supabase.from("profiles").select("id, display_name").in("id", ids);
  if (!error) {
    for (const p of (data ?? []) as { id: string; display_name: string }[]) {
      nameById.set(p.id, p.display_name);
    }
  }
  return nameById;
}

export async function listPackageEvents(packageId: string): Promise<PackageEvent[]> {
  // One log now: the package's timeline is its movements rows (ticket 05).
  const modern = await supabase
    .from("movements")
    .select("*")
    .eq("package_id", packageId)
    .order("created_at", { ascending: false });
  if (!modern.error) {
    const rows = ((modern.data ?? []) as MovementRow[]).map(movementToPackageEvent);
    const nameById = await resolveActorNames(rows.map((r) => r.actor));
    return rows.map((r) => ({ ...r, actor_name: r.actor ? (nameById.get(r.actor) ?? null) : null }));
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
  const rows = (legacy.data ?? []) as PackageEvent[];
  const nameById = await resolveActorNames(rows.map((r) => r.actor));
  return rows.map((r) => ({ ...r, actor_name: r.actor ? (nameById.get(r.actor) ?? null) : null }));
}

/** A movements row as the container trail needs it (ticket 13). */
export interface ContainerMovementRow {
  id: string;
  event: string;
  from_container_id: string | null;
  to_container_id: string | null;
  from_location_id: string | null;
  to_location_id: string | null;
  reason: string | null;
  actor: string | null;
  /** `actor` resolved to a display name, filled in by listContainerMovements —
   * same pattern as PackageEvent.actor_name. */
  actor_name: string | null;
  created_at: string;
}

/**
 * Where this container has been: its moves (nesting, slots) and its address
 * changes, newest first. Address changes are 'moved' rows whose reason carries
 * the from → to in words — reusing the event was the price of never touching
 * movements_event_ck again (ticket 13).
 */
export async function listContainerMovements(
  containerId: string,
): Promise<ContainerMovementRow[]> {
  const { data, error } = await supabase
    .from("movements")
    .select(
      "id, event, from_container_id, to_container_id, from_location_id, to_location_id, reason, actor, created_at",
    )
    .eq("container_id", containerId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    // Deploy window: a database that predates the fold-in has no container_id.
    if (isMissingColumn(error, "container_id") || isMissingTable(error, "movements")) {
      return [];
    }
    throw error;
  }
  const rows = (data ?? []) as ContainerMovementRow[];
  const nameById = await resolveActorNames(rows.map((r) => r.actor));
  return rows.map((r) => ({ ...r, actor_name: r.actor ? (nameById.get(r.actor) ?? null) : null }));
}

/**
 * Every PACKAGE movement since `iso` (the warehouse day recap, pick 26) —
 * neither ContainerDetail's nor PackageSheet's movements read fits, since
 * both scope to one subject rather than "today, everything." No lead gate:
 * "movements crew read" is `for select to authenticated using (true)`, so
 * this is exactly as open as the packages and deliveries the same card
 * reads alongside it.
 */
export async function listMovementsSince(iso: string): Promise<MovementRow[]> {
  const { data, error } = await supabase
    .from("movements")
    .select("id, package_id, event, from_container_id, to_container_id, project_id, reason, actor, created_at")
    .not("package_id", "is", null)
    .gte("created_at", iso)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTable(error, "movements") || isMissingColumn(error, "package_id")) return [];
    throw error;
  }
  return (data ?? []) as MovementRow[];
}

/**
 * Declare "this window arrives as N packages" and mint the missing labels,
 * pre-bound to job + window + part i of N (ticket 15, ADR-0005). Foreman+.
 * Returns only the rows minted NOW — declaring 4 when 1 and 3 exist returns
 * 2 and 4. A different total than existing labels carry is refused by name.
 */
export async function mintMarkPackages(input: {
  projectId: string;
  markCode: string;
  total: number;
  category?: string;
}): Promise<StoragePackage[]> {
  const { data, error } = await supabase.rpc("mint_mark_packages", {
    p_project: input.projectId,
    p_mark: input.markCode,
    p_total: input.total,
    p_category: input.category ?? "windows",
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(normalizePackage);
}

/**
 * Burn minted labels that never lived (ticket 16). Foreman+. All-or-nothing:
 * one label with history refuses the whole batch by serial and points at
 * Reprint. A missing id is skipped — already gone is what burning wanted.
 */
export async function burnPackages(packageIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("burn_packages", {
    p_packages: packageIds,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * Grow (or set) a window's package count, renumbering every label it already
 * has (owner ask, 2026-08-18: the missed fourth box, the add-on ordered
 * later). Foreman+; refuses to shrink below an existing part number.
 */
export async function setMarkPartTotal(input: {
  projectId: string;
  markCode: string;
  total: number;
}): Promise<number> {
  const { data, error } = await supabase.rpc("set_mark_part_total", {
    p_project: input.projectId,
    p_mark: input.markCode,
    p_total: input.total,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/**
 * Put an already-tagged package on its window, REPLACING any window it had
 * (owner ask, 2026-08-18): fixes both the package tagged before the worksheet
 * existed (no window at all) and the mis-typed window. Foreman+; the mark
 * must be on the package's own job's schedule.
 */
export async function setPackageWindow(
  packageId: string,
  markCode: string,
): Promise<StoragePackage> {
  const { data, error } = await supabase.rpc("set_package_window", {
    p_package: packageId,
    p_mark: markCode,
  });
  if (error) throw error;
  return normalizePackage(data as Record<string, unknown>);
}

/** Link a container to its Studio shell (ticket 22). Supervisor+ — a shell
 * IS a Studio project, and this matches Studio authoring's own gate. */
export async function setContainerModel(
  containerId: string,
  studioProjectId: string | null,
): Promise<StorageContainer> {
  const { data, error } = await supabase.rpc("set_container_model", {
    p_container: containerId,
    p_studio: studioProjectId,
  });
  if (error) throw error;
  return data as StorageContainer;
}

/** What the maker's label claims, when it disagrees with ours (ticket 20).
 * Any crew — whoever is at the truck is who saw it. Null clears a misread. */
export async function reportMakerCount(
  packageId: string,
  total: number | null,
): Promise<StoragePackage> {
  const { data, error } = await supabase.rpc("report_maker_count", {
    p_package: packageId,
    p_total: total,
  });
  if (error) throw error;
  return normalizePackage(data as Record<string, unknown>);
}

/**
 * The Boneyard's one exit (ticket 18). Foreman+ — putting material on a job
 * changes what that job expects. Desk work, not conex work: no offline queue,
 * a real error surfaces (same call as minting).
 */
export async function assignPackageToJob(input: {
  packageId: string;
  projectId: string;
  markCode: string;
}): Promise<StoragePackage> {
  const { data, error } = await supabase.rpc("assign_package_to_job", {
    p_package: input.packageId,
    p_project: input.projectId,
    p_mark: input.markCode,
  });
  if (error) throw error;
  return normalizePackage(data as Record<string, unknown>);
}

/** Flip pre-labeled packages to received — the truck-side confirm. Any crew. */
export async function receiveMintedPackages(packageIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("receive_minted_packages", {
    p_packages: packageIds,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Point at where in the box a package sits. Foreman+; the server checks the
 * area fits the KIND of the box the package is in right now. */
export async function setPackageArea(
  packageId: string,
  area: string | null,
): Promise<StoragePackage> {
  const { data, error } = await supabase.rpc("set_package_area", {
    p_package: packageId,
    p_area: area,
  });
  if (error) throw error;
  return data as StoragePackage;
}

/** A custom note on any tagged piece — any signed-in crew, same as
 * report_maker_count. Null clears it. Capped at 1000 characters server-side;
 * the RPC raises a plain-English error before the check constraint would. */
export async function setPackageNote(
  packageId: string,
  note: string | null,
): Promise<StoragePackage> {
  const { data, error } = await supabase.rpc("set_package_note", {
    p_package: packageId,
    p_note: note,
  });
  if (error) throw error;
  return normalizePackage(data as Record<string, unknown>);
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
  /** Empty/absent + boneyard=true means company stock (ticket 17). */
  projectId: string | null;
  /** The Boneyard, said on purpose — never inferred from a missing job. */
  boneyard?: boolean;
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
    p_project: input.boneyard ? null : input.projectId,
    p_boneyard: input.boneyard ?? false,
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

  // Deploy window: the database still has an older signature. Retrying with
  // fewer fields is only safe when there is nothing to lose — a tag WITH part
  // data must fail loudly rather than silently shed it, and a BONEYARD tag
  // must never fall back at all: an old database would refuse the null job
  // with the wrong words, or worse.
  if (isMissingFunction(error) && !hasParts && !input.boneyard) {
    const { p_boneyard: _drop, ...legacyArgs } = base;
    const legacy = await supabase.rpc("bind_package", legacyArgs);
    if (legacy.error) throw legacy.error;
    return legacy.data as StoragePackage;
  }
  throw error;
}

/** Fix a bound package's part number/label after the fact — the boxes'
 *  own printed order decides, so the crew re-labels with the box in hand. */
export async function setPackagePart(
  packageId: string,
  partIndex: number | null,
  partTotal: number | null,
  partType: string | null,
  applyToSiblings = false,
): Promise<void> {
  const { error } = await supabase.rpc("set_package_part", {
    p_package: packageId,
    p_part_index: partIndex,
    p_part_total: partTotal,
    p_part_type: partType,
    p_apply_to_siblings: applyToSiblings,
  });
  if (error) throw error;
}

export interface DeliveryEntryPayload {
  project_id: string | null;
  job_name: string | null;
  sets: unknown[];
}

/** The QR-less wizard's save: everything lands in one call, or nothing does. */
export async function createManualDelivery(
  label: string,
  entries: unknown[],
): Promise<{ delivery_id: string; created: number; unfiled: number; pending: number }> {
  const { data, error } = await supabase.rpc("create_manual_delivery", {
    p_label: label,
    p_entries: entries,
  });
  if (error) throw error;
  return data as {
    delivery_id: string;
    created: number;
    unfiled: number;
    pending: number;
  };
}

export interface DeliveryRow {
  id: string;
  label: string | null;
  arrived_on: string | null;
  expected_at?: string | null;
  created_at?: string | null;
}

export async function listDeliveries(): Promise<DeliveryRow[]> {
  const { data, error } = await supabase
    .from("package_deliveries")
    .select("id, label, arrived_on, expected_at")
    .order("arrived_on", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as DeliveryRow[];
}

export async function listDeliveryPackages(
  deliveryId: string,
): Promise<StoragePackage[]> {
  const { data, error } = await withMarkJoin((select) =>
    supabase
      .from("packages")
      .select(select)
      .eq("delivery_id", deliveryId)
      .order("bound_at"),
  );
  if (error) throw error;
  return (data ?? []) as unknown as StoragePackage[];
}

/** The arrival checkbox: expected (minted) flips to received. Idempotent. */
export async function receivePackages(packageIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("receive_minted_packages", {
    p_packages: packageIds,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Check something in on the spot — no delivery list, job optional,
 *  any label, optionally attached to a set by mark. */
export async function customCheckin(input: {
  containerId: string;
  projectId: string | null;
  mark: string | null;
  partType: string | null;
  note: string | null;
  count: number;
}): Promise<number> {
  const { data, error } = await supabase.rpc("custom_checkin", {
    p_container: input.containerId,
    p_project: input.projectId,
    p_mark: input.mark,
    p_part_type: input.partType,
    p_note: input.note,
    p_count: input.count,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Undo an arrival tap: received flips back to expected. Idempotent-ish —
 *  the server skips anything a person actually put away. */
export async function unreceivePackages(packageIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("unreceive_packages", {
    p_packages: packageIds,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Rename a delivery / set when the truck is expected. Foreman+. */
export async function updateDelivery(
  deliveryId: string,
  patch: { label?: string; expectedAt?: string },
): Promise<void> {
  const { error } = await supabase.rpc("update_delivery", {
    p_delivery: deliveryId,
    p_label: patch.label ?? null,
    p_expected_at: patch.expectedAt ?? null,
  });
  if (error) throw error;
}

/** Delete a delivery: expected pieces die with the list; arrived material
 *  survives and just loses its truck reference. Foreman+. */
export async function deleteDelivery(
  deliveryId: string,
): Promise<{ killed: number; kept: number }> {
  const { data, error } = await supabase.rpc("delete_delivery", {
    p_delivery: deliveryId,
  });
  if (error) throw error;
  return data as { killed: number; kept: number };
}

/** Put the truck on the schedule: date+time + who meets it. Supervisor+. */
export async function scheduleDelivery(
  deliveryId: string,
  whenISO: string,
  memberIds: string[],
): Promise<void> {
  const { error } = await supabase.rpc("schedule_delivery", {
    p_delivery: deliveryId,
    p_when: whenISO,
    p_member_ids: memberIds,
  });
  if (error) throw error;
}

/** Edit a crate-pool row's piece count as glass gets used (1-99). */
export async function setPieceCount(
  packageId: string,
  count: number,
): Promise<void> {
  const { error } = await supabase.rpc("set_piece_count", {
    p_package: packageId,
    p_count: count,
  });
  if (error) throw error;
}

/** One more sealed crate than the list said — add it to match reality. */
export async function addJobCrate(
  projectId: string,
  name?: string,
): Promise<void> {
  const { error } = await supabase.rpc("add_job_crate", {
    p_project: projectId,
    p_name: name ?? null,
  });
  if (error) throw error;
}

/** Un-put-away: stored flips back to arrived-and-loose, container cleared. */
export async function unstorePackages(packageIds: string[]): Promise<number> {
  const { data, error } = await supabase.rpc("unstore_packages", {
    p_packages: packageIds,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Label every id at once — "what is it?" answered at the tailgate. */
export async function labelPackages(
  packageIds: string[],
  partType: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("label_packages", {
    p_packages: packageIds,
    p_part_type: partType,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** File no-job material onto its freshly built job. Foreman+. */
export async function filePendingPackages(
  packageIds: string[],
  projectId: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("file_pending_packages", {
    p_package_ids: packageIds,
    p_project: projectId,
  });
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Permanent. The server refuses checked-out packages and names them. */
export async function deletePackages(
  packageIds: string[],
): Promise<{ deleted: number; refused: { serial: string; reason: string }[] }> {
  const { data, error } = await supabase.rpc("delete_packages", {
    p_package_ids: packageIds,
  });
  if (error) throw error;
  return data as { deleted: number; refused: { serial: string; reason: string }[] };
}

export async function listPartTypeOptions(): Promise<string[]> {
  const { data, error } = await supabase
    .from("part_type_options")
    .select("name")
    .order("name");
  if (error) throw error;
  return (data ?? []).map((r) => r.name as string);
}

export async function addPartTypeOption(name: string): Promise<string> {
  const { data, error } = await supabase.rpc("add_part_type_option", {
    p_name: name,
  });
  if (error) throw error;
  return (data as { name: string }).name;
}

export interface PendingDeliverySet {
  id: string;
  delivery_id: string;
  job_name: string;
  mark_code: string;
  kind: string;
  package_count: number;
  crate_name: string | null;
  crate_pieces: number | null;
  materialized_at: string | null;
}

export async function listPendingDeliverySets(): Promise<PendingDeliverySet[]> {
  const { data, error } = await supabase
    .from("pending_delivery_sets")
    .select(
      "id, delivery_id, job_name, mark_code, kind, package_count, crate_name, crate_pieces, materialized_at",
    )
    .is("materialized_at", null)
    .order("created_at");
  if (error) throw error;
  return (data ?? []) as PendingDeliverySet[];
}

export async function materializePendingSet(
  setId: string,
  projectId: string,
): Promise<void> {
  const { error } = await supabase.rpc("materialize_pending_set", {
    p_set: setId,
    p_project: projectId,
  });
  if (error) throw error;
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
  /**
   * package id -> "bucket/path" for whichever damaged packages got a photo
   * (ticket 11). Build this only from paths whose upload is ALREADY queued
   * (see ArrivePackages.tsx and enqueueIssuePhoto) — arrive_packages writes
   * whatever it is given straight onto the issue it opens, so a path handed
   * in here has to be one something has actually promised to deliver bytes
   * to, never a guess.
   */
  photos?: Record<string, string>;
}): Promise<number> {
  const { data, error } = await supabase.rpc("arrive_packages", {
    p_ok: input.okIds,
    p_damaged: input.damagedIds,
    p_project: input.projectId,
    p_note: input.note ?? null,
    p_photos: input.photos ?? {},
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
 * Whole days since the package's most recent 'stored' movement — separate
 * from agingDays, which measures since it was first bound. A package can be
 * bound for months while passing through two or three containers along the
 * way; this answers "how long has it sat where it is now," not "how old is
 * the tag." Null when it has never been stored (nothing in the history says
 * so) or the timestamp doesn't parse.
 */
export function daysInStorage(
  events: Pick<PackageEvent, "event" | "created_at">[],
  now: Date,
): number | null {
  let latest: string | null = null;
  for (const e of events) {
    if (e.event !== "stored") continue;
    if (latest === null || Date.parse(e.created_at) > Date.parse(latest)) latest = e.created_at;
  }
  return agingDays(latest, now);
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
  part_type?: string | null;
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
/**
 * What a picker row calls a package: "#6 1/4 · Frame" (owner ask,
 * 2026-08-18 — the checkout list showed job and category but hid the window
 * number and the piece, the two things the tag screen just collected).
 * Degrades honestly: a mark with no fraction is "#6", a fraction with no mark
 * is "1/4", a piece alone is "Frame", nothing is null.
 */
export function pieceLine(
  p: Pick<StoragePackage, "part_index" | "part_total" | "part_type"> & {
    package_marks?: { mark_code: string }[];
  },
): string | null {
  const marks = (p.package_marks ?? []).map((m) => `#${m.mark_code}`).join(", ");
  const frac =
    p.part_index != null && p.part_total != null
      ? `${p.part_index}/${p.part_total}`
      : null;
  const kind = p.part_type
    ? (PART_LABELS[p.part_type as PartType] ?? p.part_type)
    : null;
  const where = marks && frac ? `${marks} ${frac}` : marks || frac;
  return [where, kind].filter(Boolean).join(" · ") || null;
}

export function partLabel(p: PartLike): string | null {
  const num = hasPartNumber(p) ? `Part ${p.part_index} of ${p.part_total}` : null;
  const kind = p.part_type
    ? (PART_LABELS[p.part_type as PartType] ?? p.part_type)
    : null;
  if (num && kind) return `${num} · ${kind}`;
  return num ?? kind;
}

// -------------------------------------------------------- damage photos (11)

/** Where a damage report's photos live — private, path-scoped by project id,
 * same shape as install-media / trip-attachments (20260922000000). */
export const ISSUE_PHOTOS_BUCKET = "issue-photos";

/**
 * Deterministic, bucket-relative path for a damage-report photo. Both call
 * sites that need one — the queued upload (enqueueIssuePhoto) and the
 * arrivePackages() call that tells the issue where to find it — call this
 * function rather than building the string twice, so they can never drift
 * onto two different paths for what is supposed to be the same photo.
 */
export function damagePhotoPath(projectId: string, packageId: string, now: number): string {
  return `${projectId}/${packageId}-${now}.jpg`;
}

// -------------------------------------------------------- package photos (28)
//
// See 20260936000000_package_photos.sql for why this reuses `attachments`
// (kind='photo', package_id) and the install-media bucket rather than a new
// table/bucket. Uploads go through the generic photo_upload outbox op
// (lib/offline/outbox.ts's enqueueUpload) — the same queue-then-drain path
// job photos use — because "Add a photo" has no already-happening online RPC
// call to ride along with the way arrive_packages does for damage photos
// (ticket 11); both the row and the bytes need to survive a dead conex wall.

export interface PackagePhoto {
  id: string;
  storagePath: string;
  signedUrl: string | null;
  createdAt: string;
  createdBy: string | null;
}

/**
 * Every photo hung off one package, oldest first — a simple filmstrip, so a
 * shot just taken lands at the end where the person who took it is looking.
 * Degrades to empty on a database that predates package_id (deploy window)
 * or lacks `attachments` entirely, same as every other read in this file.
 */
export async function listPackagePhotos(packageId: string): Promise<PackagePhoto[]> {
  const { data, error } = await supabase
    .from("attachments")
    .select("id, storage_path, created_at, created_by")
    .eq("package_id", packageId)
    .eq("kind", "photo")
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingColumn(error, "package_id") || isMissingTable(error, "attachments")) return [];
    throw error;
  }
  const rows = (data ?? []) as {
    id: string;
    storage_path: string;
    created_at: string;
    created_by: string | null;
  }[];
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      storagePath: r.storage_path,
      signedUrl: await signedMedia(r.storage_path),
      createdAt: r.created_at,
      createdBy: r.created_by,
    })),
  );
}

/**
 * Bucket-relative path for a package photo. Unlike damagePhotoPath (one
 * report, one photo, one instant) "Add a photo" can queue several shots at
 * once — a multi-select file picker, or two fast taps — so a random suffix
 * rides along with the millisecond timestamp to keep same-tick shots apart.
 * Exported for tests; the caller (PackageSheet) mints `rand` itself so the
 * function stays pure.
 */
export function packagePhotoPath(packageId: string, now: number, rand: string): string {
  return `packages/${packageId}/${now}-${rand}.jpg`;
}

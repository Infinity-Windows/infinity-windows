import { supabase } from "./supabase";

/**
 * Warranty / after-service cases (Phase 4 — closes the plan-set -> warranty
 * loop). A service_case is opened AFTER install against a specific installed
 * unit; the server derives the unit's project + type and its latest install
 * event + installer automatically, so every callback is attributed back to the
 * window type / installer / procedure that drove it.
 *
 * The RPC wrappers mirror the guarded server functions (foreman+). The
 * attribution grouping below is a PURE helper (no DB / React) so the fail-point
 * summary that leads rely on is unit-testable.
 */

export type ServiceCaseStatus = "open" | "scheduled" | "resolved";

export interface ServiceCase {
  id: string;
  window_id: string;
  install_event_id: string | null;
  project_id: string | null;
  opening_id: string | null;
  window_type_id: string | null;
  installer_id: string | null;
  status: ServiceCaseStatus;
  reason: string | null;
  fail_point: string | null;
  description: string | null;
  reported_by: string | null;
  created_at: string;
  scheduled_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
}

export const SERVICE_STATUS_LABELS: Record<ServiceCaseStatus, string> = {
  open: "Open",
  scheduled: "Revisit scheduled",
  resolved: "Resolved",
};

/**
 * Fail-point attribution options offered when opening a warranty / service case.
 * `fail_point` is free text in the DB (no enum / CHECK constraint), so these are
 * suggestions surfaced in a picker — any of these OR a custom value is accepted,
 * and every existing free-text value keeps working. "Manufacturer" attributes a
 * callback to a factory / defective-unit fault (vs an install or product fault),
 * and then rolls up under the Service page's "By fail point" attribution.
 */
export const FAIL_POINT_OPTIONS = [
  "Installation",
  "Seal",
  "Flashing",
  "Hardware",
  "Glass",
  "Manufacturer",
  "Other",
] as const;

/**
 * Open a warranty / after-service case against a physical unit. The server
 * derives project + window type + the latest install event + installer.
 * Foreman+ (enforced by the RPC). Returns the new case.
 */
export async function openServiceCase(params: {
  windowId: string;
  reason: string;
  failPoint?: string | null;
  description?: string | null;
}): Promise<ServiceCase> {
  const { data, error } = await supabase.rpc("open_service_case", {
    p_window_id: params.windowId,
    p_reason: params.reason,
    p_fail_point: params.failPoint ?? null,
    p_description: params.description ?? null,
  });
  if (error) throw error;
  return data as ServiceCase;
}

/** Schedule the revisit for a case (status 'scheduled'). Foreman+ (RPC). */
export async function scheduleServiceCase(
  id: string,
  when: string,
): Promise<ServiceCase> {
  const { data, error } = await supabase.rpc("schedule_service_case", {
    p_id: id,
    p_when: when,
  });
  if (error) throw error;
  return data as ServiceCase;
}

/** Resolve a case (status 'resolved' + optional note). Foreman+ (RPC). */
export async function resolveServiceCase(
  id: string,
  note?: string | null,
): Promise<ServiceCase> {
  const { data, error } = await supabase.rpc("resolve_service_case", {
    p_id: id,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data as ServiceCase;
}

/** Cross-project service-case feed (foreman+; guarded server-side). */
export async function listServiceCases(): Promise<ServiceCase[]> {
  const { data, error } = await supabase.rpc("list_service_cases");
  if (error) throw error;
  return (data ?? []) as ServiceCase[];
}

/** Every service case for one physical unit (shown inline on its history). */
export async function listWindowServiceCases(
  windowId: string,
): Promise<ServiceCase[]> {
  const { data, error } = await supabase
    .from("service_cases")
    .select("*")
    .eq("window_id", windowId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ServiceCase[];
}

// --- Fail-point attribution (pure) ------------------------------------------

/** Which dimension to attribute warranty callbacks to. */
export type AttributionDimension = "window_type" | "installer" | "fail_point";

export interface AttributionRow {
  /** The grouping key (a window_type_id / installer_id / fail_point string). */
  key: string;
  total: number;
  open: number;
  scheduled: number;
  resolved: number;
}

/** Placeholder key for cases missing the grouped dimension. */
export const ATTRIBUTION_UNKNOWN = "unknown";

function keyFor(c: ServiceCase, dimension: AttributionDimension): string {
  const raw =
    dimension === "window_type"
      ? c.window_type_id
      : dimension === "installer"
        ? c.installer_id
        : c.fail_point;
  const trimmed = (raw ?? "").trim();
  return trimmed === "" ? ATTRIBUTION_UNKNOWN : trimmed;
}

/**
 * Group service cases by a dimension (window type / installer / fail point) and
 * count them by status, so leads can see which products, people, and procedures
 * drive warranty callbacks. Sorted by total descending (worst offenders first),
 * then by key for a stable order. Cases missing the dimension collapse into a
 * single ATTRIBUTION_UNKNOWN bucket.
 */
export function attributeServiceCases(
  cases: ServiceCase[],
  dimension: AttributionDimension,
): AttributionRow[] {
  const byKey = new Map<string, AttributionRow>();
  for (const c of cases) {
    const key = keyFor(c, dimension);
    let row = byKey.get(key);
    if (!row) {
      row = { key, total: 0, open: 0, scheduled: 0, resolved: 0 };
      byKey.set(key, row);
    }
    row.total += 1;
    row[c.status] += 1;
  }
  return [...byKey.values()].sort(
    (a, b) => b.total - a.total || a.key.localeCompare(b.key),
  );
}

/** Count of cases still needing action (open + scheduled). */
export function activeCaseCount(cases: ServiceCase[]): number {
  return cases.filter((c) => c.status !== "resolved").length;
}

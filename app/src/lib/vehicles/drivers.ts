import type { VehicleDriver } from "./types";

// Pure driver-display helpers. A driver is either an app profile (show its
// joined display_name) or a typed free-text name. Kept free of React/Supabase.

/** Display label for one driver: profile name, typed name, or a safe fallback. */
export function driverDisplayName(driver: VehicleDriver): string {
  if (driver.profile_id) return driver.display_name?.trim() || "Crew member";
  return driver.name?.trim() || "Driver";
}

/** The single primary driver, if one is set. */
export function primaryDriver(drivers: VehicleDriver[]): VehicleDriver | null {
  return drivers.find((d) => d.relation === "primary") ?? null;
}

/** Additional insured drivers (everything that isn't the primary). */
export function insuredDrivers(drivers: VehicleDriver[]): VehicleDriver[] {
  return drivers.filter((d) => d.relation === "insured");
}

/** "Sam Diaz" or "Sam Diaz +2" for a compact card line. */
export function driverSummary(drivers: VehicleDriver[]): string {
  const primary = primaryDriver(drivers);
  const insured = insuredDrivers(drivers);
  if (!primary && insured.length === 0) return "No driver";
  const head = primary ? driverDisplayName(primary) : driverDisplayName(insured[0]);
  const extra = primary ? insured.length : insured.length - 1;
  return extra > 0 ? `${head} +${extra}` : head;
}

/**
 * Normalize an editor's driver rows into the canonical shape the API stores:
 * exactly one of profile_id / name is kept, blanks are dropped, and only a
 * single primary survives (the first primary row wins; the rest become insured).
 */
export function normalizeDrivers(rows: VehicleDriver[]): VehicleDriver[] {
  const out: VehicleDriver[] = [];
  let sawPrimary = false;
  for (const row of rows) {
    const hasProfile = Boolean(row.profile_id);
    const name = row.name?.trim() || null;
    if (!hasProfile && !name) continue; // drop empty rows
    let relation = row.relation;
    if (relation === "primary") {
      if (sawPrimary) relation = "insured";
      else sawPrimary = true;
    }
    out.push({
      profile_id: hasProfile ? row.profile_id : null,
      name: hasProfile ? null : name,
      relation,
      display_name: row.display_name ?? null,
    });
  }
  return out;
}

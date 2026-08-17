// One box, every identifier, one answer (warehouse ticket 08, grill Q4).
//
// The warehouse exists to answer one question — "where is it" — so the page
// keeps that question on screen permanently and this resolves it. Typed or
// scanned, the same path: job code, window mark, package serial, short code,
// the manufacturer's own number, or a conex.
//
// What comes back is NOT a list of search results to pick through. It is the
// CHAIN: unit -> package -> crate -> conex, and when the thing asked about is
// a whole window, one row per piece with the "2 of 3" verdict on top. "Where
// is it" is a physical question and deserves a physical answer.
//
// Pure over already-fetched rows: the page holds the queries, this holds the
// rules, and both are testable without a database.

import type { StorageContainer, StoragePackage } from "../storage";
import { placeChain, placeLabel } from "./containment";
import { partsHeadline, unitParts, type UnitPartsReport } from "./unitParts";

/**
 * A physical window unit from the older inventory system, with the rack slot
 * it joined in. Two systems still describe the warehouse (see ADR-0004 and
 * ticket 08b): packages, and these units. Until the units retire, one search
 * box has to answer for BOTH or it is not the one box it claims to be.
 */
export interface UnitLike {
  id: string;
  window_id: string;
  short_code?: string | null;
  serial?: string | null;
  status: string;
  location_id: string | null;
  locations?: { address: string } | null;
  window_types?: { type_code?: string | null; name?: string | null } | null;
}

export interface FindInputs {
  packages: StoragePackage[];
  containers: StorageContainer[];
  /** Active jobs, for matching a typed job code. */
  projects: { id: string; job_code: string; name: string | null }[];
  /** Marks on active jobs — lets a search for "17" answer even when nothing
   * is tagged for it yet ("no packages tagged for window 17"). */
  scheduledMarks?: { project_id: string; mark_code: string }[];
  /** Units from the older system, so their IDs and slots still answer. */
  units?: UnitLike[];
}

/** One package, with where it sits spelled out. */
export interface PackageHit {
  pkg: StoragePackage;
  /** "Crate 7 — inside Conex 3", "loose — no container, no slot", … */
  where: string;
}

export type FindAnswer =
  /** A whole window: its parts and the completeness verdict. */
  | {
      kind: "unit";
      markCode: string;
      projectId: string;
      jobCode: string;
      report: UnitPartsReport;
      headline: string;
      hits: PackageHit[];
    }
  /** One package, found by its sticker or the manufacturer's number. */
  | { kind: "package"; hit: PackageHit }
  /** A container and what is in it. */
  | { kind: "container"; container: StorageContainer; hits: PackageHit[] }
  /** A whole job. */
  | { kind: "job"; projectId: string; jobCode: string; hits: PackageHit[] }
  /** One physical unit from the older system, and the slot it sits on. */
  | { kind: "unit-row"; unit: UnitLike; where: string }
  /** A rack slot, and what is on it. */
  | { kind: "slot"; address: string; units: UnitLike[]; hits: PackageHit[] }
  /** Nothing matched — say what to do next, never "no results". */
  | { kind: "miss"; query: string; suggestion: string };

function describe(
  pkg: StoragePackage,
  containersById: Map<string, StorageContainer>,
): PackageHit {
  if (pkg.status === "checked_out") return { pkg, where: "checked out to a job" };
  return { pkg, where: placeLabel(placeChain(pkg, containersById)) };
}

/**
 * Where a unit is, in the older system's own terms. Its status carries both
 * condition AND location there (the thing ADR-0004 is unwinding), so the
 * answer reads off whichever the status implies.
 */
export function unitWhere(u: UnitLike): string {
  const slot = u.locations?.address;
  switch (u.status) {
    case "installed":
      return "installed";
    case "loaded":
      return "on the truck";
    case "on_site":
      return "on site";
    case "damaged":
      return slot ? `damaged — held on ${slot}` : "damaged — held";
    case "staged":
      return slot ? `staged on ${slot}` : "staged for a job";
    case "inbound":
      return "arrived, no slot yet";
    case "pre_issued":
      return "expected, not arrived";
    default:
      return slot ? `on ${slot}` : "in the warehouse, no slot yet";
  }
}

/**
 * Resolve one query. Order matters: the most specific identifier wins, so a
 * sticker code never gets swallowed by a job whose name happens to contain it.
 */
export function findInWarehouse(raw: string, inputs: FindInputs): FindAnswer | null {
  const query = raw.trim().toUpperCase();
  if (query.length < 2) return null;

  const { packages, containers, projects, scheduledMarks = [], units = [] } = inputs;
  const byId = new Map(containers.map((c) => [c.id, c]));
  const jobCodeOf = new Map(projects.map((p) => [p.id, p.job_code]));

  // 1. A package sticker — serial, short code, or the manufacturer's number.
  const pkg = packages.find(
    (p) =>
      p.serial.toUpperCase() === query ||
      (p.short_code ?? "").toUpperCase() === query ||
      (p.mfr_mark ?? "").toUpperCase() === query,
  );
  if (pkg) return { kind: "package", hit: describe(pkg, byId) };

  // 1b. A unit from the older system, by its printed id / short code / serial.
  //     Same tier as a package sticker: both are a thing you hold in your hand.
  const unit = units.find(
    (u) =>
      u.window_id.toUpperCase() === query ||
      (u.short_code ?? "").toUpperCase() === query ||
      (u.serial ?? "").toUpperCase() === query,
  );
  if (unit) {
    return { kind: "unit-row", unit, where: unitWhere(unit) };
  }

  // 2. A container, by serial or by name ("conex 3").
  const container = containers.find(
    (c) => c.serial.toUpperCase() === query || c.name.toUpperCase() === query,
  );
  if (container) {
    const hits = packages
      .filter((p) => p.status === "stored" && p.container_id === container.id)
      .map((p) => describe(p, byId));
    return { kind: "container", container, hits };
  }

  // 2b. A rack or staging slot, by its printed address ("S-01-A", "J-BLACK22-A").
  const slotUnits = units.filter(
    (u) => (u.locations?.address ?? "").toUpperCase() === query,
  );
  const slotPackages = packages.filter(
    (p) => p.status !== "checked_out" && p.location_id != null,
  );
  if (slotUnits.length > 0) {
    return {
      kind: "slot",
      address: query,
      units: slotUnits,
      // Packages carry a location_id too (ticket 04); once the shelf flow
      // exists they show here beside the units on the same shelf.
      hits: slotPackages
        .filter((p) => slotUnits.some((u) => u.location_id === p.location_id))
        .map((p) => describe(p, byId)),
    };
  }

  // 3. A job code.
  const project = projects.find((p) => p.job_code.toUpperCase() === query);
  if (project) {
    const hits = packages
      .filter((p) => p.project_id === project.id)
      .map((p) => describe(p, byId));
    return { kind: "job", projectId: project.id, jobCode: project.job_code, hits };
  }

  // 4. A window mark. Tagged packages first; failing that, the schedule — so
  //    "17" answers "nothing tagged yet" instead of pretending 17 isn't real.
  const tagged = packages.find(
    (p) =>
      p.project_id != null &&
      (p.package_marks ?? []).some((m) => m.mark_code.toUpperCase() === query),
  );
  const scheduled = scheduledMarks.find(
    (m) => m.mark_code.trim().toUpperCase() === query,
  );
  const markProject = tagged?.project_id ?? scheduled?.project_id ?? null;
  if (markProject) {
    const report = unitParts(packages, markProject, query);
    return {
      kind: "unit",
      markCode: query,
      projectId: markProject,
      jobCode: jobCodeOf.get(markProject) ?? "?",
      report,
      headline: partsHeadline(report).text,
      hits: report.rows.map((p) => describe(p, byId)),
    };
  }

  // 5. Nothing. Say what to do about it.
  return {
    kind: "miss",
    query: raw.trim(),
    suggestion:
      "No sticker, window, shelf, conex or job by that name. If the material is here, tag it at the truck — until a sticker goes on, nobody can be told where it is.",
  };
}

/** The one-line answer, for the collapsed state and for screen readers. */
export function answerHeadline(a: FindAnswer): string {
  switch (a.kind) {
    case "unit":
      return `Window ${a.markCode} · ${a.jobCode} — ${a.headline}`;
    case "package":
      return `${a.hit.pkg.short_code ?? a.hit.pkg.serial} — ${a.hit.where}`;
    case "container":
      return `${a.container.name} — ${a.hits.length} package${a.hits.length === 1 ? "" : "s"} inside`;
    case "job":
      return `${a.jobCode} — ${a.hits.length} package${a.hits.length === 1 ? "" : "s"} tagged`;
    case "unit-row":
      return `${a.unit.window_id} — ${a.where}`;
    case "slot":
      return `${a.address} — ${a.units.length} unit${a.units.length === 1 ? "" : "s"}`;
    case "miss":
      return `Nothing found for “${a.query}”`;
  }
}

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

export interface FindInputs {
  packages: StoragePackage[];
  containers: StorageContainer[];
  /** Active jobs, for matching a typed job code. */
  projects: { id: string; job_code: string; name: string | null }[];
  /** Marks on active jobs — lets a search for "17" answer even when nothing
   * is tagged for it yet ("no packages tagged for window 17"). */
  scheduledMarks?: { project_id: string; mark_code: string }[];
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
 * Resolve one query. Order matters: the most specific identifier wins, so a
 * sticker code never gets swallowed by a job whose name happens to contain it.
 */
export function findInWarehouse(raw: string, inputs: FindInputs): FindAnswer | null {
  const query = raw.trim().toUpperCase();
  if (query.length < 2) return null;

  const { packages, containers, projects, scheduledMarks = [] } = inputs;
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
      "No sticker, window, conex or job by that name. If the material is here, tag it at the truck — until a sticker goes on, nobody can be told where it is.",
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
    case "miss":
      return `Nothing found for “${a.query}”`;
  }
}

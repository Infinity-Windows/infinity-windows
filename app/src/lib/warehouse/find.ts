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
import { placeWhere, type PlaceLocation } from "./containment";
import { partsHeadline, unitParts, type UnitPartsReport } from "./unitParts";

export interface FindInputs {
  packages: StoragePackage[];
  containers: StorageContainer[];
  /** Active jobs, for matching a typed job code. */
  projects: { id: string; job_code: string; name: string | null }[];
  /** Marks on active jobs — lets a search for "17" answer even when nothing
   * is tagged for it yet ("no packages tagged for window 17"). */
  scheduledMarks?: { project_id: string; mark_code: string }[];
  /**
   * Every rack and staging bay, keyed by id — what names the job a staged
   * package is set aside for instead of a bare "on a shelf".
   *
   * Required, unlike the two optional fields above. This is the exact field
   * that went missing from every real screen: when it defaulted, a staged
   * package read "on a shelf" everywhere and nothing failed. A caller with no
   * locations loaded yet has to pass an empty Map on purpose.
   */
  locationsById: Map<string, PlaceLocation>;
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
  /**
   * More than one job has a window by that number. Marks are position numbers,
   * so "16" is real on several jobs at once — ask which, never guess.
   */
  | {
      kind: "mark-choices";
      markCode: string;
      choices: {
        projectId: string;
        jobCode: string;
        /** The completeness verdict for that job's copy — "2 of 3 here". */
        headline: string;
        /** Where the first piece sits, so two jobs tell themselves apart. */
        where: string | null;
      }[];
    }
  /** A whole job. */
  | { kind: "job"; projectId: string; jobCode: string; hits: PackageHit[] }
  /** One physical unit from the older system, and the slot it sits on. */
  /** A rack slot, and what is on it. */
  | { kind: "slot"; address: string; hits: PackageHit[] }
  /** Nothing matched — say what to do next, never "no results". */
  | { kind: "miss"; query: string; suggestion: string };

function describe(
  pkg: StoragePackage,
  containersById: Map<string, StorageContainer>,
  locationsById: Map<string, PlaceLocation>,
): PackageHit {
  if (pkg.status === "checked_out") return { pkg, where: "checked out to a job" };
  // A minted label's material has not arrived. Without this branch it falls
  // through to "loose — no container, no slot", which sends somebody hunting
  // the warehouse for a package that is still on a truck somewhere (ticket 15).
  if (pkg.status === "minted") return { pkg, where: "on the way — not arrived yet" };
  return { pkg, where: placeWhere(pkg, containersById, locationsById) };
}

/**
 * Resolve one query. Order matters: the most specific identifier wins, so a
 * sticker code never gets swallowed by a job whose name happens to contain it.
 */
export function findInWarehouse(
  raw: string,
  inputs: FindInputs,
  /** A job already picked from the mark pick-list, so the second look-up
   * lands straight on that job's window. */
  opts?: { markProjectId?: string },
): FindAnswer | null {
  const query = raw.trim().toUpperCase();
  if (query.length < 2) return null;

  const {
    packages,
    containers,
    projects,
    scheduledMarks = [],
    locationsById,
  } = inputs;
  const byId = new Map(containers.map((c) => [c.id, c]));
  const jobCodeOf = new Map(projects.map((p) => [p.id, p.job_code]));

  // 1. A package sticker — serial, short code, or the manufacturer's number.
  const pkg = packages.find(
    (p) =>
      p.serial.toUpperCase() === query ||
      (p.short_code ?? "").toUpperCase() === query ||
      (p.mfr_mark ?? "").toUpperCase() === query,
  );
  if (pkg) return { kind: "package", hit: describe(pkg, byId, locationsById) };

  // 2. A container, by serial or by name ("conex 3").
  const container = containers.find(
    (c) => c.serial.toUpperCase() === query || c.name.toUpperCase() === query,
  );
  if (container) {
    const hits = packages
      .filter((p) => p.status === "stored" && p.container_id === container.id)
      .map((p) => describe(p, byId, locationsById));
    return { kind: "container", container, hits };
  }

  // 2b. A rack or staging slot, by its printed address ("S-01-A",
  //     "J-BLACK22-A"). Resolved against the LOCATIONS themselves (audit F7,
  //     finished by ticket 21): the old path only answered when a unit from
  //     the retired chain happened to be parked there — 8 real staging bays,
  //     1 unit staged, so it failed for essentially every real bay.
  const slotEntry = [...locationsById.entries()].find(
    ([, l]) => (l.address ?? "").toUpperCase() === query,
  );
  if (slotEntry) {
    const [slotId, slot] = slotEntry;
    return {
      kind: "slot",
      address: slot.address ?? query,
      hits: packages
        .filter((p) => p.status !== "checked_out" && p.location_id === slotId)
        .map((p) => describe(p, byId, locationsById)),
    };
  }

  // 3. A job code.
  const project = projects.find((p) => p.job_code.toUpperCase() === query);
  if (project) {
    const hits = packages
      .filter((p) => p.project_id === project.id)
      .map((p) => describe(p, byId, locationsById));
    return { kind: "job", projectId: project.id, jobCode: project.job_code, hits };
  }

  // 4. A window mark. Tagged packages first, then the schedule — so "17"
  //    answers "nothing tagged yet" instead of pretending 17 isn't real.
  //
  //    A mark is a position number off the plans, and it is only unique WITHIN
  //    a job (project_marks: unique (project_id, mark_code)). Two jobs running
  //    at once both have a window 16. Taking the first match handed back a
  //    confident, fully detailed answer about a different window on a different
  //    job — so gather every job the mark could mean, and only ask when there
  //    is more than one.
  const taggedProjectIds = packages
    .filter(
      (p) =>
        p.project_id != null &&
        (p.package_marks ?? []).some((m) => m.mark_code.toUpperCase() === query),
    )
    .map((p) => p.project_id as string);
  const scheduledProjectIds = scheduledMarks
    .filter((m) => m.mark_code.trim().toUpperCase() === query)
    .map((m) => m.project_id);
  const markProjectIds = new Set([...taggedProjectIds, ...scheduledProjectIds]);

  // Once somebody has picked a job off the list, that pick wins outright —
  // that is the "no second question" half of the promise.
  if (opts?.markProjectId && markProjectIds.has(opts.markProjectId)) {
    markProjectIds.clear();
    markProjectIds.add(opts.markProjectId);
  }

  if (markProjectIds.size === 1) {
    const [markProject] = markProjectIds;
    const report = unitParts(packages, markProject, query);
    return {
      kind: "unit",
      markCode: query,
      projectId: markProject,
      jobCode: jobCodeOf.get(markProject) ?? "?",
      report,
      headline: partsHeadline(report).text,
      hits: report.rows.map((p) => describe(p, byId, locationsById)),
    };
  }
  if (markProjectIds.size > 1) {
    // Job code first: it is the one word that tells an installer which of the
    // two windows is theirs. Then what is here, then where it sits.
    const choices = [...markProjectIds]
      .map((projectId) => {
        const report = unitParts(packages, projectId, query);
        const first = report.rows[0]
          ? describe(report.rows[0], byId, locationsById)
          : null;
        return {
          projectId,
          jobCode: jobCodeOf.get(projectId) ?? "?",
          headline: partsHeadline(report).text,
          where: first?.where ?? null,
        };
      })
      .sort((a, b) => a.jobCode.localeCompare(b.jobCode));
    return { kind: "mark-choices", markCode: query, choices };
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
    case "mark-choices":
      return `Window ${a.markCode} — ${a.choices.length} jobs have one`;
    case "package":
      return `${a.hit.pkg.short_code ?? a.hit.pkg.serial} — ${a.hit.where}`;
    case "container":
      return `${a.container.name} — ${a.hits.length} package${a.hits.length === 1 ? "" : "s"} inside`;
    case "job":
      return `${a.jobCode} — ${a.hits.length} package${a.hits.length === 1 ? "" : "s"} tagged`;
    case "slot":
      return `${a.address} — ${a.hits.length} package${a.hits.length === 1 ? "" : "s"}`;
    case "miss":
      return `Nothing found for “${a.query}”`;
  }
}

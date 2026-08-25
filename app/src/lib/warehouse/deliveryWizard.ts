// The QR-less delivery wizard's brain (owner spec, 2026-08-21 night: no
// scanner, no printer, a truck at the dock in the morning).
//
// The wizard collects a SKELETON: which jobs, which marks, how many packages,
// what's riding in a crate — deliberately NOT which package is the frame and
// which is the glass. The owner's reason: the physical labels decide that
// order ("could be frame 1/3, glass 2/3 — or rotated"), so part labels are
// assigned later on the package screen, where the box is in front of you.
//
// Crate rule (owner design): crated pieces are NOT part of a set's 1-of-N
// numbering. Three loose packages say 3 of 3, and the crate row says
// "4 pieces of glass in Crate 1". One crate serves one job but many marks.

export interface WizardCrate {
  name: string;
  pieces: number;
  /** Defaults to glass — the thing crates exist for. */
  part_type: string;
}

export interface WizardSet {
  mark: string;
  kind: "window" | "door";
  package_count: number;
  crate: WizardCrate | null;
}

export interface WizardEntry {
  /** A real job's id — or null when the job isn't built yet. */
  project_id: string | null;
  /** The typed name when project_id is null. */
  job_name: string;
  sets: WizardSet[];
}

export const MAX_PROJECTS = 17;
export const MAX_SETS = 50;
export const MAX_PACKAGES = 20;
export const MAX_CRATE_PIECES = 99;

export function emptySet(): WizardSet {
  return { mark: "", kind: "window", package_count: 1, crate: null };
}

export function emptyEntry(): WizardEntry {
  return { project_id: null, job_name: "", sets: [emptySet()] };
}

/** Normalize a typed mark the way the warehouse stores them: no '#', upper. */
export function normalizeMark(raw: string): string {
  return raw.trim().replace(/^#/, "").toUpperCase();
}

/** Every problem that would make the save refuse, in plain words. */
export function wizardProblems(entries: WizardEntry[]): string[] {
  const problems: string[] = [];
  if (entries.length === 0) problems.push("Log at least one job's material.");
  if (entries.length > MAX_PROJECTS)
    problems.push(`A delivery covers at most ${MAX_PROJECTS} jobs.`);
  entries.forEach((entry, ei) => {
    const label = entry.project_id
      ? `Job ${ei + 1}`
      : entry.job_name.trim()
        ? `"${entry.job_name.trim()}"`
        : `Job ${ei + 1}`;
    if (!entry.project_id && !entry.job_name.trim()) {
      problems.push(`${label}: pick a job or type its name.`);
    }
    if (entry.sets.length === 0) {
      problems.push(`${label}: add at least one set.`);
    }
    if (entry.sets.length > MAX_SETS) {
      problems.push(`${label}: at most ${MAX_SETS} sets in one delivery.`);
    }
    const seen = new Set<string>();
    entry.sets.forEach((set, si) => {
      const mark = normalizeMark(set.mark);
      if (!mark) {
        problems.push(`${label}, set ${si + 1}: every set needs a mark (like 16 or 13A).`);
      } else if (seen.has(mark)) {
        problems.push(`${label}: mark #${mark} is listed twice.`);
      } else {
        seen.add(mark);
      }
      if (set.package_count < 1 || set.package_count > MAX_PACKAGES) {
        problems.push(
          `${label}, #${mark || si + 1}: a set arrives as 1 to ${MAX_PACKAGES} packages.`,
        );
      }
      if (set.crate) {
        if (!set.crate.name.trim()) {
          problems.push(`${label}, #${mark || si + 1}: name the crate (like Crate 1).`);
        }
        if (set.crate.pieces < 1 || set.crate.pieces > MAX_CRATE_PIECES) {
          problems.push(
            `${label}, #${mark || si + 1}: crate pieces are 1 to ${MAX_CRATE_PIECES}.`,
          );
        }
      }
    });
  });
  return problems;
}

/** The payload create_manual_delivery expects, built from clean state. */
export function buildDeliveryPayload(entries: WizardEntry[]): unknown[] {
  return entries.map((entry) => ({
    project_id: entry.project_id,
    job_name: entry.project_id ? null : entry.job_name.trim(),
    sets: entry.sets.map((set) => ({
      mark: normalizeMark(set.mark),
      kind: set.kind,
      package_count: set.package_count,
      crate: set.crate
        ? {
            name: set.crate.name.trim(),
            pieces: set.crate.pieces,
            part_type: set.crate.part_type.trim() || "glass",
          }
        : null,
    })),
  }));
}

/** One line the review screen shows per set. */
export function describeSet(set: WizardSet): string {
  const mark = normalizeMark(set.mark) || "?";
  const base = `#${mark} · ${set.kind === "door" ? "Door" : "Window"} · ${set.package_count} package${set.package_count === 1 ? "" : "s"}`;
  if (!set.crate) return base;
  return `${base} + ${set.crate.pieces} piece${set.crate.pieces === 1 ? "" : "s"} of ${set.crate.part_type || "glass"} in ${set.crate.name.trim() || "a crate"}`;
}

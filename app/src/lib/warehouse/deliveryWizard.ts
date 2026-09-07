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

import { CATALOG } from "../i18n/catalog";
import { translate, type Lang } from "../i18n/translate";
import type { TFn } from "../i18n/context";

const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

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
  /** Clone mode: how many IDENTICAL units this set covers (6 matching
   *  5050s = one mark, quantity 6). Each unit gets the same packages and
   *  the same crate pieces. */
  quantity: number;
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
export const MAX_CLONES = 20;

export function emptySet(): WizardSet {
  return { mark: "", kind: "window", package_count: 1, quantity: 1, crate: null };
}

export function emptyEntry(): WizardEntry {
  return { project_id: null, job_name: "", sets: [emptySet()] };
}

/** Normalize a typed mark the way the warehouse stores them: no '#', upper. */
export function normalizeMark(raw: string): string {
  return raw.trim().replace(/^#/, "").toUpperCase();
}

/** Every problem that would make the save refuse, in plain words. */
export function wizardProblems(entries: WizardEntry[], t: TFn = englishT): string[] {
  const problems: string[] = [];
  if (entries.length === 0) problems.push(t("storage.logDelivery.problem.needOneJob"));
  if (entries.length > MAX_PROJECTS)
    problems.push(t("storage.logDelivery.problem.tooManyJobs", { max: MAX_PROJECTS }));
  entries.forEach((entry, ei) => {
    const label = entry.project_id
      ? t("storage.logDelivery.problem.jobN", { n: ei + 1 })
      : entry.job_name.trim()
        ? `"${entry.job_name.trim()}"`
        : t("storage.logDelivery.problem.jobN", { n: ei + 1 });
    if (!entry.project_id && !entry.job_name.trim()) {
      problems.push(t("storage.logDelivery.problem.pickOrType", { label }));
    }
    if (entry.sets.length === 0) {
      problems.push(t("storage.logDelivery.problem.addOneSet", { label }));
    }
    if (entry.sets.length > MAX_SETS) {
      problems.push(t("storage.logDelivery.problem.atMostSets", { label, max: MAX_SETS }));
    }
    const seen = new Set<string>();
    entry.sets.forEach((set, si) => {
      const mark = normalizeMark(set.mark);
      if (!mark) {
        problems.push(t("storage.logDelivery.problem.needsMark", { label, n: si + 1 }));
      } else if (seen.has(mark)) {
        problems.push(t("storage.logDelivery.problem.listedTwice", { label, mark }));
      } else {
        seen.add(mark);
      }
      if (set.quantity < 1 || set.quantity > MAX_CLONES) {
        problems.push(
          t("storage.logDelivery.problem.clonesRange", { label, mark: mark || si + 1, max: MAX_CLONES }),
        );
      }
      if (set.package_count < 1 || set.package_count > MAX_PACKAGES) {
        problems.push(
          t("storage.logDelivery.problem.packagesRange", { label, mark: mark || si + 1, max: MAX_PACKAGES }),
        );
      }
      if (set.crate) {
        if (!set.crate.name.trim()) {
          problems.push(t("storage.logDelivery.problem.nameCrate", { label, mark: mark || si + 1 }));
        }
        if (set.crate.pieces < 1 || set.crate.pieces > MAX_CRATE_PIECES) {
          problems.push(
            t("storage.logDelivery.problem.cratePiecesRange", { label, mark: mark || si + 1, max: MAX_CRATE_PIECES }),
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
      quantity: set.quantity,
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
export function describeSet(set: WizardSet, t: TFn = englishT): string {
  const mark = normalizeMark(set.mark) || "?";
  const clones = set.quantity > 1 ? t("storage.logDelivery.describe.clones", { n: set.quantity }) : "";
  const each = set.quantity > 1 ? t("storage.logDelivery.describe.each") : "";
  const kind = t(set.kind === "door" ? "storage.logDelivery.describe.door" : "storage.logDelivery.describe.window");
  const base = t(set.package_count === 1 ? "storage.logDelivery.describe.base.one" : "storage.logDelivery.describe.base.many", {
    mark,
    kind,
    clones,
    n: set.package_count,
    each,
  });
  if (!set.crate) return base;
  return t(set.crate.pieces === 1 ? "storage.logDelivery.describe.crate.one" : "storage.logDelivery.describe.crate.many", {
    base,
    n: set.crate.pieces,
    partType: set.crate.part_type || t("warehouse.partType.glass").toLowerCase(),
    each,
    crateName: set.crate.name.trim() || t("storage.logDelivery.describe.aCrate"),
  });
}

// ---------------------------------------------------------------- drafts
// The checkpoint (owner ask): a refresh mid-list must not lose the truck.
// Every change autosaves to the device; a fresh open offers to pick the
// draft back up; a successful save clears it.

export const DRAFT_KEY = "infinity.deliveryDraft";

export interface DeliveryDraft {
  v: 1;
  label: string;
  entries: WizardEntry[];
  savedAt: string;
}

export function serializeDraft(label: string, entries: WizardEntry[], savedAt: string): string {
  return JSON.stringify({ v: 1, label, entries, savedAt } satisfies DeliveryDraft);
}

/** Null when missing, corrupt, or from a different shape version. */
export function parseDraft(raw: string | null): DeliveryDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as DeliveryDraft;
    if (d?.v !== 1 || !Array.isArray(d.entries) || typeof d.label !== "string") {
      return null;
    }
    // Older drafts may predate a field; fill what validation expects.
    d.entries = d.entries.map((e) => ({
      project_id: e.project_id ?? null,
      job_name: e.job_name ?? "",
      sets: (e.sets ?? []).map((s) => ({
        mark: s.mark ?? "",
        kind: s.kind === "door" ? "door" : "window",
        package_count: s.package_count ?? 1,
        quantity: s.quantity ?? 1,
        crate: s.crate
          ? {
              name: s.crate.name ?? "",
              pieces: s.crate.pieces ?? 1,
              part_type: s.crate.part_type ?? "glass",
            }
          : null,
      })),
    }));
    return d;
  } catch {
    return null;
  }
}

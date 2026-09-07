// One scan does the next thing (warehouse redesign wave 2, owner call
// 2026-09-06): the scan sheet reads a package's state and leads with the one
// verb that follows it. Expected → Arrive. Arrived and loose → Put away, or
// "Put with the rest of window 16" when the unit's other pieces already sit in
// one box. Stored → Move, Check out. Out on a job → Back in storage. A blank
// sticker → Tag. "Fix something" is always last and never first.
//
// Pure over already-fetched rows, so the order is testable without a camera.
// Labels are bilingual (SignIn+ sweep, 2026-09-06): callers pass their live
// `t`; a test that calls these with no `t` gets English, same as before.

import type { StorageContainer, StoragePackage } from "../storage";
import { CATALOG } from "../i18n/catalog";
import { translate, type Lang } from "../i18n/translate";
import type { TFn } from "../i18n/context";

const englishT: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);

export type ScanVerbId =
  | "tag"
  | "arrive"
  | "put_away"
  | "put_with_rest"
  | "move"
  | "check_out"
  | "back_in"
  | "fix";

export interface ScanVerb {
  id: ScanVerbId;
  label: string;
  /** Plain words under the label — where "the rest" is, what happens next. */
  hint: string | null;
  /** The box "Put with the rest" would store into. */
  containerId?: string;
}

/** Where a unit's other pieces sit, when they all sit in ONE box. */
export function restOfUnitBox(
  pkg: Pick<StoragePackage, "id" | "project_id" | "package_marks" | "container_id">,
  all: readonly StoragePackage[],
): string | null {
  const mark = pkg.package_marks?.[0]?.mark_code;
  if (!mark || !pkg.project_id) return null;
  const boxes = new Set<string>();
  for (const p of all) {
    if (p.id === pkg.id) continue;
    if (p.project_id !== pkg.project_id) continue;
    if (!(p.package_marks ?? []).some((m) => m.mark_code === mark)) continue;
    if (p.status !== "stored" || !p.container_id) continue;
    boxes.add(p.container_id);
  }
  if (boxes.size !== 1) return null;
  const [box] = boxes;
  return box === pkg.container_id ? null : box;
}

export function scanVerbs(
  pkg: StoragePackage,
  all: readonly StoragePackage[],
  containersById: Map<string, StorageContainer>,
  t: TFn = englishT,
): ScanVerb[] {
  const rest = restOfUnitBox(pkg, all);
  const restName = rest ? (containersById.get(rest)?.name ?? t("scan.verb.sameBox")) : null;
  const mark = pkg.package_marks?.[0]?.mark_code;
  const withRest: ScanVerb | null =
    rest && mark
      ? {
          id: "put_with_rest",
          label: t("scan.verb.putWithRest.label", { mark }),
          hint: restName,
          containerId: rest,
        }
      : null;
  const fix: ScanVerb = {
    id: "fix",
    label: t("scan.verb.fix.label"),
    hint: t("scan.verb.fix.hint"),
  };

  switch (pkg.status) {
    case "blank":
      return [
        { id: "tag", label: t("scan.verb.tag.label"), hint: t("scan.verb.tag.hint") },
        fix,
      ];
    case "minted":
      return [
        { id: "arrive", label: t("scan.verb.arrive.label"), hint: t("scan.verb.arrive.hint") },
        fix,
      ];
    case "received":
      return [
        ...(withRest ? [withRest] : []),
        { id: "put_away", label: t("scan.verb.putAway.label"), hint: t("scan.verb.putAway.hint") },
        { id: "check_out", label: t("scan.verb.checkOut.label"), hint: null },
        fix,
      ];
    case "stored":
      return [
        ...(withRest ? [withRest] : []),
        { id: "move", label: t("scan.verb.move.label"), hint: null },
        { id: "check_out", label: t("scan.verb.checkOut.label"), hint: null },
        fix,
      ];
    case "checked_out":
      return [
        { id: "back_in", label: t("scan.verb.backIn.label"), hint: t("scan.verb.putAway.hint") },
        fix,
      ];
    default:
      return [fix];
  }
}

/** The verbs that apply to EVERY package in a multi-scan. Only what all of
 *  them can do together is offered; mixed states fall back to the safe pair. */
export function verbsForMany(pkgs: readonly StoragePackage[], t: TFn = englishT): ScanVerb[] {
  if (pkgs.length === 0) return [];
  const statuses = new Set(pkgs.map((p) => p.status));
  if (statuses.size === 1 && statuses.has("minted")) {
    return [
      {
        id: "arrive",
        label: t("scan.verb.arriveAll", { n: pkgs.length }),
        hint: t("scan.verb.thenPutAway"),
      },
    ];
  }
  const out: ScanVerb[] = [];
  if (![...statuses].some((s) => s === "blank" || s === "minted")) {
    out.push({
      id: "put_away",
      label: t("scan.verb.putAllAway", { n: pkgs.length }),
      hint: t("scan.verb.putAway.hint"),
    });
  }
  if ([...statuses].every((s) => s === "received" || s === "stored")) {
    out.push({ id: "check_out", label: t("scan.verb.checkOutAll", { n: pkgs.length }), hint: null });
  }
  return out;
}

/** Which verb the sheet leads with — the first one, by construction. */
export function primaryVerb(verbs: readonly ScanVerb[]): ScanVerb | null {
  return verbs[0] ?? null;
}

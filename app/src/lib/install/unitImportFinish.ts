import type { CadUnitDraft } from "./cadUnitPreview";
import { MM_PER_INCH } from "./dimensionEntry";
import type { UnitDetails } from "./unitDetails";

/** One opening of the reviewed import draft, as the Finish step sees it. */
export type ImportOpening = {
  key: string;
  mark: string;
  floor: string | null;
  sheet?: number;
  draft?: Pick<CadUnitDraft, "kind" | "label" | "sheet" | "widthMm" | "heightMm" | "configuration" | "material">;
};

export type ImportUnit = { key: string; code: string; mark: string; floor: string | null; details: UnitDetails; reason: string };
export type ImportLeftOut = { key: string; mark: string; floor: string | null; why: "no-definition" | "type-unclear" };

const floorNumber = (floor: string | null) => floor?.match(/-?\d{1,3}/)?.[0] ?? null;
const byNumber = (left: string, right: string) => left.localeCompare(right, undefined, { numeric: true });

/**
 * Turn the reviewed import draft into the units Finish will add to the job.
 *
 * Nothing in the import reaches the job before this runs (Matt, 2026-11-20:
 * "until then we shouldn't actually build those units onto the job").
 *
 * A plan mark names a kind of unit, not one unit, so each opening gets the
 * mark plus a running number ("6-1", "6-2"), the convention the reviewed
 * Building 3 list already uses. Numbering continues after any unit of that
 * mark already on the job, so a later import never reuses a number.
 *
 * An opening with no CAD definition, or one whose definition has no type, is
 * left out and reported: save_unit_details refuses a defined unit without a
 * type, and guessing one would put a wrong unit in front of the crew.
 */
export function planImportUnits(openings: readonly ImportOpening[], existingCodes: readonly string[]) {
  const taken = new Set(existingCodes.map(code => code.trim().toLowerCase()));
  const units: ImportUnit[] = [];
  const leftOut: ImportLeftOut[] = [];
  const ordered = [...openings].sort((left, right) =>
    byNumber(floorNumber(left.floor) ?? "999", floorNumber(right.floor) ?? "999") || byNumber(left.mark, right.mark));
  const next = new Map<string, number>();
  for (const opening of ordered) {
    const mark = opening.mark.trim().replace(/^#/, "");
    const kind = opening.draft?.kind;
    if (!opening.draft) { leftOut.push({ key: opening.key, mark, floor: opening.floor, why: "no-definition" }); continue; }
    if (!kind) { leftOut.push({ key: opening.key, mark, floor: opening.floor, why: "type-unclear" }); continue; }
    let number = next.get(mark.toLowerCase()) ?? 1;
    while (taken.has(`${mark}-${number}`.toLowerCase())) number++;
    const code = `${mark}-${number}`;
    taken.add(code.toLowerCase());
    next.set(mark.toLowerCase(), number + 1);
    const { widthMm, heightMm, configuration, material, label, sheet } = opening.draft;
    const floor = floorNumber(opening.floor);
    units.push({
      key: opening.key, code, mark, floor: opening.floor,
      details: {
        placeholder: false, kind,
        ...(floor ? { floor } : {}),
        ...(widthMm ? { width: widthMm / MM_PER_INCH } : {}),
        ...(heightMm ? { height: heightMm / MM_PER_INCH } : {}),
        ...(widthMm || heightMm ? { basis: "drawing" as const } : {}),
        ...(configuration ? { configuration } : {}),
        ...(material ? { material } : {}),
      },
      reason: `Imported from drawings: plan mark ${mark}${opening.sheet ? `, plan sheet ${opening.sheet}` : ""}; CAD sheet ${sheet}: ${label}`.slice(0, 500),
    });
  }
  return { units, leftOut };
}

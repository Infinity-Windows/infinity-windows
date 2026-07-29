import { isForemanPlus, openingMarkCode } from "./types";

/**
 * Tapping a window/door in a list opens the same details a map pin opens.
 *
 * The lists are long — 42 unassigned openings on a phone — and the reason for
 * opening a row is usually "which window is this?", asked while part-way down
 * the list. So a row EXPANDS the detail panel in place and a second tap closes
 * it; it never navigates, which would throw away the foreman's scroll position
 * mid-dispatch. The full opening sheet stays one tap further in, from inside
 * the panel.
 */

export interface OpeningRowTarget {
  id: string;
  opening_code: string;
}

/** A row tap toggles: same row again closes, a different row swaps. */
export function toggleExpandedOpening(
  current: string | null,
  openingId: string,
): string | null {
  return current === openingId ? null : openingId;
}

/**
 * What the row button announces. Screen readers get the opening AND its mark,
 * because `12-1` and `12-2` sound alike read aloud but are different holes in
 * the wall. Codes with no mark suffix (`18A`) are their own mark, so saying it
 * twice would just be noise.
 */
export function openingRowLabel(openingCode: string): string {
  const code = openingCode.trim().replace(/^#/, "");
  if (!code) return "Open details for this opening";
  const mark = openingMarkCode(code);
  const suffix =
    mark.toUpperCase() === code.toUpperCase() ? "" : `, mark ${mark}`;
  return `Open details for ${code}${suffix}`;
}

/** The fuller opening sheet. Ids can change on a re-extract; that screen
 *  recovers a dead id from the opening code, so linking by id is safe. */
export function openingFullSheetPath(
  projectId: string,
  openingId: string,
): string {
  return `/projects/${projectId}/opening/${openingId}`;
}

/**
 * Whether this row/panel should read "install undone — redo needed".
 *
 * A voided install is foreman-and-above information: installers never see the
 * red ring on the map, and must not see it in a detail panel either. The role
 * check lives here so the map, the map list and dispatch cannot drift apart.
 */
export function showsVoidedInstall(
  role: string | null | undefined,
  opening: { id: string; status: string },
  voidedIds: ReadonlySet<string>,
): boolean {
  if (!isForemanPlus(role)) return false;
  if (opening.status === "installed") return false;
  return voidedIds.has(opening.id);
}

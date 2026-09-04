// "Data off" on the real job map — wave E (transcripts-program-spec).
//
// THE RULE THIS PROTECTS. A pin says two things and has always said exactly
// two: fill = window or door, ring = install status. The map lost that argument
// once, when status was moved onto the fill and every mark on a planned job came
// out the same colour, and job-map.spec asserts those two tokens because of it.
// Wave E adds a THIRD fact — "the paperwork on this one is wrong" — so it has to
// arrive as its own marker and leave both tokens alone. That is what this file
// checks, and it checks it on BLACK22's real 42 marks and its real planset PDF,
// not on a clean synthetic square: the failure mode being guarded against is a
// crowded page, and a crowded page is the only place it shows up.
//
// It also opens the missed-unit door, which every role gets (the server checks
// an open shift on the job, not a rank), so an installer on a ladder can record
// a window the plans never had.

import { expect, test, type Page } from "@playwright/test";
import {
  buildingPlansetFor,
  jobFixtures,
  openingsFor,
  plansetPdfPath,
  useSupabaseFixtures,
} from "./support/supabaseFixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/**
 * Two of the job's REAL openings, flagged. Picked by taking the first two rows
 * the fixture actually has a pin for, so the marks that come back amber are
 * marks that are genuinely drawn on that sheet.
 */
function flaggedPair(): { id: string; code: string }[] {
  return openingsFor(BLACK22.projectId)
    .filter((o) => o.pin_x !== null && o.pin_y !== null)
    .slice(0, 2)
    .map((o) => ({ id: o.id, code: o.opening_code }));
}

/** Re-answer project_openings with a data-off flag on those two rows. */
async function flagTwoUnits(page: Page, flagged: { id: string }[]) {
  const ids = new Set(flagged.map((f) => f.id));
  await page.route("**/rest/v1/project_openings**", (route) => {
    const rows = openingsFor(BLACK22.projectId).map((o) =>
      ids.has(o.id)
        ? {
            ...o,
            flag_kind: "wrong_size",
            flag_note: "ordered 3060, opening is 3050",
            flagged_at: "2026-09-03T15:00:00Z",
          }
        : o,
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` },
      body: JSON.stringify(rows),
    });
  });
}

test("a data-off unit is marked on BLACK22's real map without touching fill or ring", async ({
  page,
}) => {
  const planset = buildingPlansetFor(BLACK22.projectId);
  expect(
    plansetPdfPath(planset),
    `BLACK22's real planset PDF is missing from the storage backup ` +
      `(${planset.storage_path}). Restore docs/backups/ before trusting this run.`,
  ).not.toBeNull();

  const flagged = flaggedPair();
  expect(flagged, "the BLACK22 fixture has no pinned openings to flag").toHaveLength(2);

  await useSupabaseFixtures(page);
  await flagTwoUnits(page, flagged);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`/projects/${BLACK22.projectId}?tab=map`);

  const planSheet = page.locator(".plan-map--with-dots");
  await expect(
    planSheet.locator("img"),
    "the map did not open on the original plan",
  ).toBeVisible({ timeout: 150_000 });

  const pins = planSheet.locator(".plan-dot");
  await expect.poll(() => pins.count(), { timeout: 60_000 }).toBeGreaterThan(10);

  // Exactly the two flagged marks wear the marker, and they are the two rows
  // the fixture flagged — not merely "two of something".
  const markedIds = await planSheet
    .locator(".plan-dot:has(.plan-dot__dataoff)")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-opening-id")));
  expect(markedIds.sort()).toEqual(flagged.map((f) => f.id).sort());

  // THE LINE. Both tokens on a flagged pin read exactly as job-map.spec
  // demands of every pin: a real kind fill, a real status ring. If wave E had
  // taken either of them to say "data off", this is where it would show.
  const voices = await planSheet
    .locator(".plan-dot:has(.plan-dot__dataoff)")
    .evaluateAll((nodes) =>
      nodes.map((n) => {
        const s = getComputedStyle(n);
        return { fill: s.backgroundColor, ring: s.borderTopColor };
      }),
    );
  const kindFills = ["rgb(74, 157, 255)", "rgb(62, 207, 110)"];
  for (const v of voices) {
    expect(kindFills, `a flagged pin's fill stopped saying window-or-door`).toContain(
      v.fill,
    );
    expect(v.ring, "a flagged pin lost its status ring").not.toBe("rgba(0, 0, 0, 0)");
  }

  // And the legend says what the new marker means, rather than leaving a
  // coloured dot nobody can look up.
  await expect(page.locator(".map-legend").getByText("data off")).toBeVisible();

  expect(pageErrors, `the map threw: ${pageErrors.join(" | ")}`).toHaveLength(0);
});

test("an installer can open the missed-unit form from the map toolbar", async ({
  page,
}) => {
  // Installer on purpose: the permission is an open shift on the job, checked
  // by the server, so this door is not rank-gated and must be reachable by the
  // role with the fewest powers.
  await useSupabaseFixtures(page, { role: "installer" });
  await page.goto(`/projects/${BLACK22.projectId}?tab=map`);

  const open = page.getByRole("button", { name: "Add a missed unit" });
  await expect(open).toBeVisible({ timeout: 150_000 });
  await open.click();

  await expect(
    page.getByRole("heading", { name: /isn't on the plans/i }),
  ).toBeVisible();
  const sheet = page.locator(".missed-unit-sheet");
  await expect(sheet.getByRole("button", { name: "Window", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Door", exact: true })).toBeVisible();
  // Nothing has been tapped yet, so the sheet asks for the spot rather than
  // silently filing the unit in the middle of the page.
  await expect(page.getByText("Tap the plan where it is")).toBeVisible();
});

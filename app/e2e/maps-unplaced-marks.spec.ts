// B3 (wave V-B, the Mad Moose story): Maps Interactive used to be blind to
// schedule marks that never got a pin — the "N/N fitted" counter and the
// zero-case "no openings pinned" banner only ever look at what's already on
// the model, so a job with SOME marks placed and others simply missing read
// as quietly complete. This pins the partial-case fix: a banner line naming
// the gap and linking to the tracer (adapter.ts's unplacedScheduleMarks,
// wired through MapsInteractive.tsx — the vendored renderer itself is
// untouched by this banner).
import { expect, test, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/** One placed window ("10") on an 18x6m mass — same minimal shape used by
 * maps-view-preference.spec.ts and map-assign.spec.ts. */
const MODEL = {
  building: {
    width: 18,
    depth: 6,
    height: 3,
    rise: 0,
    footprints: [
      [
        { x: 0, z: 0 },
        { x: 18, z: 0 },
        { x: 18, z: 6 },
        { x: 0, z: 6 },
      ],
    ],
  },
  windows: [{ id: "10", elev: "s0", x: 3, y: 0.9, w: 1500, h: 1200 }],
};

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

test("the map banners a schedule mark that never got placed, and links to the tracer", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    json(
      route,
      [
        {
          id: "00000000-0000-4000-8000-0000000b1234",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model: MODEL } },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      1,
    ),
  );
  // The schedule of record knows about TWO marks; only "10" made it onto
  // the model above — "11" is the gap this banner exists to surface.
  await page.route("**/rest/v1/project_marks**", (route) =>
    json(
      route,
      [
        { project_id: BLACK22.projectId, mark_code: "10" },
        { project_id: BLACK22.projectId, mark_code: "11" },
      ],
      2,
    ),
  );

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  await expect(page.getByText("1 mark not yet placed")).toBeVisible();
  const placeThem = page.getByRole("link", { name: "place them" });
  await expect(placeThem).toBeVisible();
  await expect(placeThem).toHaveAttribute(
    "href",
    `/projects/${BLACK22.projectId}/trace-model`,
  );

  // The zero-case banner is a DIFFERENT message for a DIFFERENT condition —
  // both must never show at once.
  await expect(page.getByText(/no openings are pinned/)).toHaveCount(0);
});

test("an installer sees the count but no link — trace-model stays supervisor+", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    json(
      route,
      [
        {
          id: "00000000-0000-4000-8000-0000000b1235",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model: MODEL } },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      1,
    ),
  );
  await page.route("**/rest/v1/project_marks**", (route) =>
    json(
      route,
      [
        { project_id: BLACK22.projectId, mark_code: "10" },
        { project_id: BLACK22.projectId, mark_code: "11" },
      ],
      2,
    ),
  );

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  await expect(page.getByText("1 mark not yet placed")).toBeVisible();
  await expect(page.getByRole("link", { name: "place them" })).toHaveCount(0);
});

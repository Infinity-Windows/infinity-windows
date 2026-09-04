// Scope at a glance (wave X): the one line a job says about its own size, on
// the jobs list and under the job code on the job itself. Drives the real pages
// from a mocked project_scope_counts — the grouped view that replaced counting
// every opening row on the phone — so what is asserted here is the sentence a
// person reads, not a helper's return value.

import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const BIG_ID = "44444444-4444-4444-8444-444444444444";
const TRACK_ID = "55555555-5555-4555-8555-555555555555";

const PROJECTS = [
  {
    id: BIG_ID,
    job_code: "SCOPE01",
    name: "Alpha Ridge",
    address: null,
    status: "active",
    is_test: false,
    allowed_modes: ["data"],
    stories: 2,
  },
  {
    id: TRACK_ID,
    job_code: "SCOPE02",
    name: "Beta Callback",
    address: null,
    status: "active",
    is_test: false,
    allowed_modes: ["tracking"],
    stories: null,
  },
];

// 40 openings: 32 windows, 8 doors — five sliders, two French, one bifold.
const COUNTS = [
  {
    project_id: BIG_ID,
    openings: 40,
    installed: 32,
    windows: 32,
    doors: 8,
    door_sliders: 5,
    door_french: 2,
    door_bifold: 1,
    door_swing: 0,
    door_other: 0,
    unknown_units: 0,
  },
  // The callback has nothing on it, which is what a tracking job looks like.
  {
    project_id: TRACK_ID,
    openings: 0,
    installed: 0,
    windows: 0,
    doors: 0,
    door_sliders: 0,
    door_french: 0,
    door_bifold: 0,
    door_swing: 0,
    door_other: 0,
    unknown_units: 0,
  },
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

// Registered AFTER useSupabaseFixtures so these win. The counts route answers
// the whole list or one job, whichever the caller asked for.
async function useScopeFixtures(page: Page) {
  await page.route("**/rest/v1/projects**", (r) => json(r, PROJECTS, PROJECTS.length));
  await page.route("**/rest/v1/project_scope_counts**", (r) => {
    const url = r.request().url();
    const one = COUNTS.filter((c) => url.includes(c.project_id));
    const rows = one.length > 0 ? one : COUNTS;
    return json(r, rows, rows.length);
  });
  // No traced model on these jobs, so the storey count is the typed one.
  await page.route("**/rest/v1/project_plan_outlines**", (r) => json(r, [], 0));
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("a job card says how big the job is", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useScopeFixtures(page);
  await page.goto("/projects");

  const card = page.locator("a.project-card").first();
  await expect(card.locator("[data-scope-line]")).toHaveText(
    "40 openings · 32 windows · 8 doors · 2 stories",
  );
  // Which doors is the header's job, not the card's — the card stays one line.
  await expect(card.locator("[data-scope-line]")).not.toContainText("sliders");
});

test("a tracking job with nothing on it says so instead of showing zeroes", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useScopeFixtures(page);
  await page.goto("/projects");

  const card = page.locator("a.project-card", { hasText: "Beta Callback" });
  await expect(card.locator('[data-scope-line="tracking"]')).toHaveText("Tracking job");
});

test("the job header breaks the doors out", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useScopeFixtures(page);
  await page.goto(`/projects/${BIG_ID}`);

  await expect(page.locator(".page-header [data-scope-line]")).toHaveText(
    "40 openings · 32 windows · 8 doors (5 sliders · 2 French · 1 bifold) · 2 stories",
  );
});

// The Jobs page search bar, the schedule/recent-work groups, the "Next on
// your schedule" highlight, and the Office order toggle that replaced the
// always-on reorder rail (owner ask: less scrolling on /projects).
//
// Five jobs, hand-built rather than captured, because the grouping IS the
// test: one scheduled for today (becomes the highlight), one scheduled a few
// days out (stays in the Scheduled group), one with real time logged against
// it in the last 90 days (Recently worked), one with nothing on it at all
// (Other), and one with a long, accented name (search + no-overflow checks).
//
// No `end_time` on either schedule fixture row on purpose: `nextScheduledJob`
// only ever treats a day as "over" once an end time has actually passed
// (lib/jobsList.ts), and a real end time compared against the real wall clock
// this spec runs at would make the highlight assertions flaky depending on
// what time of day the suite happens to run. lib/jobsList.test.ts already
// proves the passed-end-time behavior without a clock to fight.

import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { dayISO, json } from "./support/specHelpers";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/jobs-search");
async function shoot(page: Page, label: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    (document.activeElement as HTMLElement | null)?.blur();
  });
  // The fixture-only database warning overlays the header; hide it only in
  // preview images, keeping production's warning and ordinary tests intact.
  await page.screenshot({ path: join(SHOTS, `${label}.png`), fullPage: false,
    style: ".pwa-banner-wrong-project { display: none !important; }" });
}

const TODAY_ID = "a0000000-1111-4111-8111-000000000001";
const FUTURE_ID = "a0000000-1111-4111-8111-000000000002";
const RECENT_ID = "a0000000-1111-4111-8111-000000000003";
const OTHER_ID = "a0000000-1111-4111-8111-000000000004";
const LONG_ID = "a0000000-1111-4111-8111-000000000005";

const ASSN_TODAY_ID = "b0000000-2222-4222-8222-000000000001";
const ASSN_FUTURE_ID = "b0000000-2222-4222-8222-000000000002";

function project(over: { id: string; job_code: string; name: string; address: string | null; pipeline?: Record<string, unknown> }) {
  const { pipeline, ...rest } = over;
  return {
    status: "active",
    is_test: false,
    allowed_modes: ["data"],
    start_date: null,
    sort_order: null,
    customer_name: null,
    ...rest,
    project_pipeline: {
      ready_state: "ready",
      materials_eta: null,
      materials_arrived_at: null,
      ...(pipeline ?? {}),
    },
  };
}

const TODAY_JOB = project({ id: TODAY_ID, job_code: "ACEQUIA1", name: "Acequia Bend", address: "1 Acequia Way" });
const FUTURE_JOB = project({ id: FUTURE_ID, job_code: "MANANA1", name: "Mañana Ridge", address: "2 Mañana Loop" });
const RECENT_JOB = project({ id: RECENT_ID, job_code: "JUNIPER1", name: "Juniper Flats", address: "3 Juniper Dr" });
const OTHER_JOB = project({ id: OTHER_ID, job_code: "ZIONV1", name: "Zion Vista", address: "4 Zion Ct" });
const LONG_JOB = project({
  id: LONG_ID,
  job_code: "LONGNAME1",
  name: "A Very Long Winding Boulevard Estates Phase Two Building Fourteen",
  address: "5 Winding Boulevard Estates Drive, Suite 1400",
});

const ALL_JOBS = [TODAY_JOB, FUTURE_JOB, RECENT_JOB, OTHER_JOB, LONG_JOB];

function assignmentRow(
  id: string,
  job: { id: string; job_code: string; name: string; address: string | null },
  startDate: string,
  endDate: string,
) {
  return {
    id,
    project_id: job.id,
    kind: "install",
    delivery_id: null,
    package_deliveries: null,
    start_date: startDate,
    end_date: endDate,
    start_time: "08:00:00",
    end_time: null,
    status: "published",
    color: null,
    note: null,
    created_by: null,
    created_via: null,
    published_at: "2026-09-25T12:00:00Z",
    created_at: "2026-09-25T12:00:00Z",
    updated_at: "2026-09-25T12:00:00Z",
    projects: { id: job.id, job_code: job.job_code, name: job.name, address: job.address },
    schedule_assignment_members: [
      { profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "E2E Fixture" } },
    ],
  };
}

/** Registered AFTER useSupabaseFixtures so these win (Playwright favours the
 * most recently added route) — the same pattern job-cards.spec.ts and
 * job-pipeline.spec.ts already use. */
async function useJobsSearchFixtures(
  page: Page,
  opts: { scheduleStatus?: number } = {},
) {
  await page.route("**/rest/v1/projects**", (r) => json(r, ALL_JOBS, ALL_JOBS.length));
  await page.route("**/rest/v1/project_scope_counts**", (r) => json(r, [], 0));
  await page.route("**/rest/v1/project_gc_checkins**", (r) => json(r, [], 0));

  if (opts.scheduleStatus) {
    await page.route("**/rest/v1/schedule_assignment_members**", (r) =>
      r.fulfill({ status: opts.scheduleStatus, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }),
    );
  } else {
    await page.route("**/rest/v1/schedule_assignment_members**", (r) =>
      json(r, [{ assignment_id: ASSN_TODAY_ID }, { assignment_id: ASSN_FUTURE_ID }], 2),
    );
    await page.route("**/rest/v1/schedule_assignments**", (r) => {
      const rows = [
        assignmentRow(ASSN_TODAY_ID, TODAY_JOB, dayISO(0), dayISO(0)),
        assignmentRow(ASSN_FUTURE_ID, FUTURE_JOB, dayISO(3), dayISO(3)),
      ];
      return json(r, rows, rows.length);
    });
  }

  await page.route("**/rest/v1/custom_work_sessions**", (r) =>
    json(r, [{ project_id: RECENT_ID, shift_status: "approved", started_at: `${dayISO(-10)}T08:00:00Z` }], 1),
  );
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

function cardNames(page: Page) {
  return page.locator("a.project-card .job-card-name").allInnerTexts();
}

test("an installer gets the grouped, searchable list with no reorder rail and no Office order toggle", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useJobsSearchFixtures(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/projects");

  await expect(page.locator("a.project-card")).toHaveCount(5);
  await expect(page.getByRole("button", { name: /office order/i })).toHaveCount(0);
  await expect(page.locator(".job-order-rail")).toHaveCount(0);
  await expect(page.locator(".job-order-spacer")).toHaveCount(0);

  // Today's job is highlighted above the list and not duplicated below it.
  await expect(page.locator(".jobs-highlight")).toContainText("Acequia Bend");
  const names = await cardNames(page);
  expect(names.filter((n) => n === "Acequia Bend")).toHaveLength(1);
  // Group headings read in order: Scheduled, Recently worked, Other.
  await expect(page.locator(".jobs-group-heading").nth(0)).toHaveText(/Scheduled/i);
  await expect(page.locator(".jobs-group-heading").nth(1)).toHaveText(/Recently worked/i);
  await expect(page.locator(".jobs-group-heading").nth(2)).toHaveText(/Other/i);

  await shoot(page, "default-grouped-list");
});

test("foreman: default view hides the rail; Office order reveals it, hides search, and still saves", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useJobsSearchFixtures(page);
  await page.route("**/rest/v1/rpc/set_projects_order", (r) => json(r, null, 0));
  await page.goto("/projects");

  await expect(page.locator("a.project-card")).toHaveCount(5);
  await expect(page.locator(".job-order-rail")).toHaveCount(0);
  await expect(page.getByLabel(/search jobs/i)).toBeVisible();

  const search = page.getByLabel(/search jobs/i);
  await search.fill("zion");
  await page.getByRole("button", { name: /^filters/i }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /office order/i })).toBeDisabled();
  await page.getByRole("dialog").getByRole("button", { name: /^close/i }).click();
  await search.fill("");
  await shoot(page, "foreman-phone");
  await page.getByRole("button", { name: /^filters/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: /office order/i }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await expect(page.locator(".job-order-rail")).toHaveCount(5);
  // Search is gone entirely while reordering — "search disables manual
  // mutations" taken to its simplest, safest form: the two never coexist.
  await expect(page.getByLabel(/search jobs/i)).toHaveCount(0);

  // The up/down buttons still work and still call the real RPC with the
  // WHOLE list's ids, from the office-order list's own full-row indices.
  const calls: unknown[] = [];
  await page.route("**/rest/v1/rpc/set_projects_order", (r) => {
    calls.push(r.request().postDataJSON());
    return json(r, null, 0);
  });
  const first = page.locator("a.project-card").first();
  await first.getByRole("button", { name: /move down/i }).click();
  await expect.poll(() => calls.length).toBeGreaterThan(0);
});

test("a schedule read failure never pretends to be empty, and every job still shows under Other, searchable", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useJobsSearchFixtures(page, { scheduleStatus: 500 });
  await page.goto("/projects");

  await expect(page.locator(".jobs-highlight")).toHaveCount(0);
  await expect(page.getByText(/couldn.t check your schedule/i)).toBeVisible();
  // The chip says it failed to load rather than claiming zero scheduled jobs.
  await expect(page.getByRole("button", { name: /scheduled/i })).toContainText(/couldn.t load/i);
  // Fallback: every job still renders. The schedule failing doesn't touch the
  // independent recent-work read, so Recently worked still groups normally —
  // only "Scheduled" is gone.
  await expect(page.locator("a.project-card")).toHaveCount(5);
  await expect(page.locator(".jobs-group-heading").filter({ hasText: /Scheduled/i })).toHaveCount(0);
  await expect(page.locator(".jobs-group-heading").filter({ hasText: /Recently worked/i })).toHaveCount(1);
  await expect(page.locator(".jobs-group-heading").filter({ hasText: /^Other/i })).toHaveCount(1);
});

test("search matches name, job code, address and accented text; clears; ignores the selected chip", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useJobsSearchFixtures(page);
  await page.goto("/projects");

  const search = page.getByLabel(/search jobs/i);

  await search.fill("zion");
  await expect(page.locator("a.project-card")).toHaveCount(1);
  await expect(page.locator("a.project-card")).toContainText("Zion Vista");

  await search.fill("juniper1"); // job code
  await expect(page.locator("a.project-card")).toContainText("Juniper Flats");

  await search.fill("acequia way"); // address, multi-token
  await expect(page.locator("a.project-card")).toContainText("Acequia Bend");

  // Accent-insensitive: "manana" finds "Mañana Ridge".
  await search.fill("manana");
  await expect(page.locator("a.project-card")).toContainText("Mañana Ridge");

  await search.fill("nothing matches this");
  await expect(page.locator("a.project-card")).toHaveCount(0);
  await expect(page.getByText(/no jobs match/i)).toBeVisible();

  // Switching to the Recent chip, then searching, still searches every job —
  // not just the recent ones.
  await search.fill("");
  await page.getByRole("button", { name: /^recent/i }).click();
  await search.fill("zion");
  await expect(page.locator("a.project-card")).toContainText("Zion Vista");
  await expect(page.getByText(/searching every active job/i)).toBeVisible();

  // Clear button empties the box and brings the full list back.
  await page.getByRole("button", { name: /clear search/i }).click();
  await expect(search).toHaveValue("");
});

test("Spanish renders the search bar and chips translated", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", language: "es" });
  await useJobsSearchFixtures(page);
  await page.goto("/projects");

  await expect(page.getByPlaceholder("Buscar trabajos")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Todos/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Programados/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Recientes/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Trabajos", exact: true })).toBeVisible();
  await shoot(page, "spanish-phone");
});

for (const width of [320, 375, 390, 430, 1280] as const) {
  test(`a long job name never causes sideways overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "installer" });
    await useJobsSearchFixtures(page);
    await page.goto("/projects");

    const longCard = page.locator("a.project-card").filter({ hasText: "A Very Long Winding" });
    await expect(longCard).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);
  });
}


test("the recommendation advances when today's scheduled slot ends on an open page", async ({ page }) => {
  const today = dayISO(0);
  await page.clock.install({ time: new Date(`${today}T14:59:00`) });
  await useSupabaseFixtures(page, { role: "installer" });
  await useJobsSearchFixtures(page);
  await page.route("**/rest/v1/schedule_assignments**", (r) => json(r, [
    { ...assignmentRow(ASSN_TODAY_ID, TODAY_JOB, today, today), end_time: "15:00:00" },
    assignmentRow(ASSN_FUTURE_ID, FUTURE_JOB, dayISO(1), dayISO(1)),
  ], 2));
  await page.goto("/projects");
  await expect(page.locator(".jobs-highlight")).toContainText("Acequia Bend");
  await page.clock.fastForward(90_000);
  await expect(page.locator(".jobs-highlight")).toContainText("Mañana Ridge");
  await expect(page.locator(".jobs-highlight")).not.toContainText("Acequia Bend");
});

test("recent-work failure and an unscheduled person keep every job searchable", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useJobsSearchFixtures(page);
  await page.route("**/rest/v1/schedule_assignment_members**", (r) => json(r, [], 0));
  await page.route("**/rest/v1/custom_work_sessions**", (r) => r.fulfill({
    status: 500, contentType: "application/json", body: JSON.stringify({ message: "Unavailable" }),
  }));
  await page.goto("/projects");
  await expect(page.locator(".jobs-highlight")).toHaveCount(0);
  await expect(page.getByText(/couldn.t load recently worked jobs/i)).toBeVisible();
  await expect(page.locator("a.project-card")).toHaveCount(5);
  await expect.poll(() => cardNames(page)).toEqual([
    LONG_JOB.name, TODAY_JOB.name, RECENT_JOB.name, FUTURE_JOB.name, OTHER_JOB.name,
  ]);
  await page.getByLabel(/search jobs/i).fill("acequia");
  await expect(page.locator("a.project-card")).toHaveCount(1);
});

test("phone jobs stay compact and management lives in the accessible Filters sheet", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useJobsSearchFixtures(page);
  await page.goto("/projects");
  const normalCard = page.locator("a.project-card").filter({ hasText: "Zion Vista" });
  await expect(normalCard).toBeVisible();
  const box = await normalCard.boundingBox();
  expect(box?.height).toBeLessThan(165);
  await expect(page.locator("a.project-card button").filter({ hasText: /delete/i })).toHaveCount(0);
  const filters = page.getByRole("button", { name: /^filters/i });
  await filters.click();
  const dialog = page.getByRole("dialog", { name: /^filters/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: /job history/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /office order/i })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(filters).toBeFocused();
  await filters.click();
  await dialog.getByRole("button", { name: /office order/i }).click();
  await expect(page.locator(".job-order-rail")).toHaveCount(5);
  await expect(page.locator("a.project-card button").filter({ hasText: /delete/i })).toHaveCount(5);
});

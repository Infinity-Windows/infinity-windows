// Wave C: the calendar that remembers. Pins the day panel's render from
// mocked routes — no live Supabase, same idiom as daily-logs.spec.ts.
// useSupabaseFixtures covers auth/profiles' shared defaults; schedule_
// assignments/time_shifts/unit_sessions/daily_logs are overridden here
// since the shared router has no opinion about scheduling data.
import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
const OAKRIDGE = jobFixtures().find((j) => j.jobCode === "OAKRIDGE")!;

const PROJECTS = [
  { id: BLACK22.projectId, job_code: "BLACK22", name: "Black Desert", address: null, status: "active" },
  { id: OAKRIDGE.projectId, job_code: "OAKRIDGE", name: "Oak Ridge", address: null, status: "active" },
];

/** "N days ago" as a local YYYY-MM-DD, built the same way Scheduling.tsx's
 * own todayLocalISO() is (local getters, not UTC) — so the fixture's dates
 * land exactly where the app itself thinks "today minus N" is, whatever
 * day this actually runs. */
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A local instant on `iso` at `hour` — built from local calendar fields
 * (dayMemory.test.ts's same idiom), so a shift lands on the calendar day
 * it's supposed to regardless of the host's timezone. */
function localInstant(iso: string, hour: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, hour, 0, 0).toISOString();
}

// A rich past day: crew assigned, crew worked (with an honest gap either
// way), a unit finished, and a log filed.
const TEST_DATE = daysAgoISO(3);
// A past day with crew assigned and nobody who ever punched in.
const FALLBACK_DATE = daysAgoISO(5);

function jsonRoute(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

async function useCalendarFixtures(page: Page) {
  await page.route("**/rest/v1/projects**", (r) => jsonRoute(r, PROJECTS, PROJECTS.length));

  const assignments = [
    {
      id: "a-black22",
      project_id: BLACK22.projectId,
      kind: "install",
      delivery_id: null,
      package_deliveries: null,
      start_date: TEST_DATE,
      end_date: TEST_DATE,
      start_time: null,
      status: "published",
      color: null,
      note: null,
      created_by: null,
      published_at: TEST_DATE,
      created_at: TEST_DATE,
      updated_at: TEST_DATE,
      // Ammon AND Jess are assigned; only Ammon (plus an unassigned Taylor)
      // actually punched in — the honest diff, both directions at once.
      schedule_assignment_members: [
        { profile_id: "e2e-ammon", role: "installer", profiles: { display_name: "Ammon" } },
        { profile_id: "e2e-jess", role: "installer", profiles: { display_name: "Jess" } },
      ],
      projects: { id: BLACK22.projectId, job_code: "BLACK22", name: "Black Desert", address: null },
    },
    {
      id: "a-oakridge",
      project_id: OAKRIDGE.projectId,
      kind: "install",
      delivery_id: null,
      package_deliveries: null,
      start_date: FALLBACK_DATE,
      end_date: FALLBACK_DATE,
      start_time: null,
      status: "published",
      color: null,
      note: null,
      created_by: null,
      published_at: FALLBACK_DATE,
      created_at: FALLBACK_DATE,
      updated_at: FALLBACK_DATE,
      schedule_assignment_members: [
        { profile_id: "e2e-taylor", role: "installer", profiles: { display_name: "Taylor" } },
      ],
      projects: { id: OAKRIDGE.projectId, job_code: "OAKRIDGE", name: "Oak Ridge", address: null },
    },
  ];
  await page.route("**/rest/v1/schedule_assignments**", (route) => {
    const url = new URL(route.request().url());
    // listDraftAssignments() asks for status=eq.draft — every fixture row
    // here is published, so that specific query is honestly empty rather
    // than mislabeling published rows as an unpublished-changes bar.
    if (url.searchParams.get("status") === "eq.draft") return jsonRoute(route, [], 0);
    return jsonRoute(route, assignments, assignments.length);
  });

  const shifts = [
    {
      id: "s-ammon",
      profile_id: "e2e-ammon",
      project_id: BLACK22.projectId,
      clock_in_at: localInstant(TEST_DATE, 8),
      clock_out_at: localInstant(TEST_DATE, 16),
      break_seconds: 0,
      status: "approved",
    },
    {
      id: "s-taylor",
      profile_id: "e2e-taylor",
      project_id: BLACK22.projectId,
      clock_in_at: localInstant(TEST_DATE, 9),
      clock_out_at: localInstant(TEST_DATE, 13),
      break_seconds: 0,
      status: "approved",
    },
  ];
  await page.route("**/rest/v1/time_shifts**", (route) => jsonRoute(route, shifts, shifts.length));

  const sessions = [
    {
      opening_id: "op-1",
      started_at: localInstant(TEST_DATE, 12),
      end_reason: "finish",
      opening: { project_id: BLACK22.projectId },
    },
  ];
  await page.route("**/rest/v1/unit_sessions**", (route) => jsonRoute(route, sessions, sessions.length));

  const logs = [
    {
      id: "log-1",
      project_id: BLACK22.projectId,
      log_date: TEST_DATE,
      headline: "2 units in, smooth day",
      notes: "Crew moved fast, no issues.",
      day_flow: "smooth",
      reflection: null,
      weather: null,
      customer_visible: false,
      filed_by: "e2e-ammon",
      updated_by: null,
      created_at: TEST_DATE,
      updated_at: TEST_DATE,
      filer: { display_name: "Ammon" },
    },
  ];
  await page.route("**/rest/v1/daily_logs**", (route) => jsonRoute(route, logs, logs.length));
}

/** Switch to Month view, step back however many calendar months separate
 * today from `dateISO`, then tap that day's cell. Exact day-number match
 * scoped to the daynum span (not the whole cell, whose worked-chips can
 * carry digits of their own — BLACK22's "22" would otherwise collide with
 * the 22nd of the month) and to a non-dimmed (in-month) cell. */
async function openMonthDay(page: Page, dateISO: string) {
  await page.getByRole("tab", { name: "Month" }).click();

  const today = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  const todayISO = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const [ty, tm] = todayISO.split("-").map(Number);
  const [dy, dm] = dateISO.split("-").map(Number);
  const monthsBack = (ty - dy) * 12 + (tm - dm);
  for (let i = 0; i < monthsBack; i++) {
    await page.getByRole("button", { name: "Previous" }).click();
  }

  const dayNumber = String(Number(dateISO.slice(-2)));
  const cell = page.locator(".sched-month-cell:not(.is-dim)").filter({
    has: page.locator(".sched-month-daynum", { hasText: new RegExp(`^${dayNumber}$`) }),
  });
  await cell.click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("a foreman taps a past day and sees the honest diff plus the filed log", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCalendarFixtures(page);

  await page.goto("/scheduling");
  await openMonthDay(page, TEST_DATE);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("BLACK22 — Black Desert")).toBeVisible();

  // Assigned vs. worked, side by side — Jess was assigned but never
  // punched in; Taylor punched in without ever being assigned.
  await expect(dialog.getByText("Ammon", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Jess", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ammon — 8h")).toBeVisible();
  await expect(dialog.getByText("Taylor — 4h")).toBeVisible();

  // The filed log's own block, not the auto fallback line.
  await expect(dialog.getByText("Smooth")).toBeVisible();
  await expect(dialog.getByText("2 units in, smooth day")).toBeVisible();
  await expect(dialog.getByText("Crew moved fast, no issues.")).toBeVisible();
  await expect(dialog.getByText("Assigned, but no crew punched in.")).toHaveCount(0);

  // Foreman+ only: the tap-through to the job's own Logs tab.
  await expect(dialog.getByRole("link", { name: "Open the Logs tab" })).toBeVisible();
});

test("a foreman taps a day where crew was assigned but nobody punched in", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useCalendarFixtures(page);

  await page.goto("/scheduling");
  await openMonthDay(page, FALLBACK_DATE);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("OAKRIDGE — Oak Ridge")).toBeVisible();
  await expect(dialog.getByText("Taylor", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Nobody punched in")).toBeVisible();
  await expect(dialog.getByText("Assigned, but no crew punched in.")).toBeVisible();
});

test("an installer sees names only — no hours, no Logs tab-through", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useCalendarFixtures(page);

  await page.goto("/scheduling");
  await openMonthDay(page, TEST_DATE);

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Ammon", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Ammon — 8h")).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "Open the Logs tab" })).toHaveCount(0);
});

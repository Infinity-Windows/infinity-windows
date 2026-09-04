// Wave K — time honesty, on the screen the office actually reads.
//
// Three things this proves against the real page rather than a unit test:
//   K3  a shift somebody left running shows where they were last seen, and
//       only because the last foreground fix is miles from where they punched
//       in AND precise enough to say so — the row for a person who has not
//       moved says nothing, and neither does the row whose fix is 3 km fuzzy.
//   K5  Team timecards steps between a week and a pay period, and the Gusto
//       file is offered for a pay period and not for a week.
//   K2  a foreman can see and move the hour the evening nudge goes out.
//
// The shifts are hand-built here (not captured fixtures) because the whole
// point is a specific geometry: one punch left open twenty hours ago from a
// phone that has since travelled fourteen miles, and one that has not moved.

import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const AWAY_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const HERE_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const FUZZY_ID = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const PROJECT_ID = "cccccccc-3333-4333-8333-cccccccccccc";

// A job in Salt Lake, and a supply house ~14 miles north of it.
const JOB = { lat: 40.76, lng: -111.89 };
const AWAY = { lat: 40.96, lng: -111.89 };

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function shift(over: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    profile_id: AWAY_ID,
    project_id: PROJECT_ID,
    cost_code_id: "dddddddd-4444-4444-8444-dddddddddddd",
    clock_in_at: hoursAgo(20),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: hoursAgo(20),
    note: null,
    clock_in_lat: JOB.lat,
    clock_in_lng: JOB.lng,
    last_seen_at: hoursAgo(1),
    last_seen_lat: AWAY.lat,
    last_seen_lng: AWAY.lng,
    last_seen_accuracy_m: 20,
    projects: { job_code: "MADMOOSE", name: "Mad Moose" },
    cost_codes: { code: "100", label: "Install — windows" },
    profiles: { display_name: "Ana Ruiz" },
    editor: null,
    voider: null,
    ...over,
  };
}

const SHIFTS = [
  shift({}),
  // Still standing where the punch started: nothing to say.
  shift({
    id: "22222222-2222-4222-8222-222222222222",
    profile_id: HERE_ID,
    last_seen_lat: JOB.lat,
    last_seen_lng: JOB.lng,
    profiles: { display_name: "Ben Cole" },
  }),
  // Fourteen miles away on paper, but from a fix with a 3 km radius — the app
  // cannot tell that from "inside the house", so it says nothing at all.
  shift({
    id: "33333333-3333-4333-8333-333333333333",
    profile_id: FUZZY_ID,
    last_seen_accuracy_m: 3_000,
    profiles: { display_name: "Cara Diaz" },
  }),
];


function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

// Registered AFTER useSupabaseFixtures so these win (Playwright favours the
// most recently added route).
async function useTimeFixtures(page: Page) {
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const url = new URL(r.request().url());
    const owner = url.searchParams.get("profile_id");
    let rows = SHIFTS;
    if (owner?.startsWith("eq.")) {
      rows = SHIFTS.filter((s) => s.profile_id === owner.slice(3));
    }
    // A `.maybeSingle()` read (the app's own open shift) wants one object.
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, rows[0] ?? null, rows.length);
    return json(r, rows, rows.length);
  });
  await page.route("**/rest/v1/company_settings**", (r) =>
    json(
      r,
      { id: 1, evening_nudge_local_time: "17:30:00", evening_nudge_enabled: true },
      1,
    ),
  );
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("a runaway punch says where the person was last seen, and only when that is away from where they clocked in", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useTimeFixtures(page);
  await page.goto("/team-timecards");

  const runaways = page.locator(".runaway-shifts");
  await expect(runaways).toBeVisible();
  // 14 miles from where the punch started, at the hour the app was last opened.
  // The sentence names the clock-in, not "the job": clocking in at the shop and
  // driving to site is a normal morning, and this number cannot tell them apart.
  await expect(
    runaways.getByText(/last seen 14 mi from where they clocked in ·/),
  ).toHaveCount(1);
  // Three people are on the list; only one of them has a fix worth reporting.
  await expect(runaways.getByText("Ana Ruiz")).toHaveCount(1);
  await expect(runaways.getByText("Ben Cole")).toHaveCount(1);
  await expect(runaways.getByText("Cara Diaz")).toHaveCount(1);
});

test("the team timecard steps to a pay period, and only a pay period offers the Gusto file", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useTimeFixtures(page);
  await page.goto("/team-timecards");

  // A week to begin with: no Gusto button, and the page says where to find it.
  await expect(page.getByRole("tab", { name: "Week" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Export pay period for Gusto" }),
  ).toHaveCount(0);
  await expect(page.getByText("Switch to Pay period to export for Gusto.")).toBeVisible();

  // The stepper's middle button IS the range label (tap it to jump back to now).
  const rangeLabel = page.locator('button[title="Jump back to now"]');
  await page.getByRole("tab", { name: "Pay period" }).click();
  await expect(rangeLabel).toHaveText(/^Pay period /);
  await expect(
    page.getByRole("button", { name: "Export pay period for Gusto" }),
  ).toBeVisible();

  // The stepper moves the window without losing the mode.
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(rangeLabel).toHaveText(/^Pay period /);
  await expect(page.getByRole("tab", { name: "Pay period" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a foreman can see and move the hour the evening reminder goes out", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useTimeFixtures(page);
  await page.goto("/team-timecards");

  await expect(page.getByText(/Evening .*reminder at 5:30/)).toBeVisible();
  const timeInput = page.getByLabel("Time of day the evening reminder goes out");
  await expect(timeInput).toHaveValue("17:30");
  await timeInput.fill("15:45");
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
});

// Clocking the crew in and out from the roster (owner ask, 2026-09-04).
//
// The owner opened Team timecards and found fourteen people clocked into
// OFFICE a minute apart, because somebody had punched fourteen phones in by
// hand. Six things this proves against the real page rather than a unit test:
//
//   1. a supervisor ticks three people and clocks them in — and the request
//      that leaves the phone carries exactly those three ids, the job, the
//      cost code and the attestation, in ONE call rather than three;
//   2. the attestation really is a gate: no tick, no button;
//   3. somebody already on ANOTHER job is left alone and named until the move
//      box is ticked, and then they are sent;
//   4. Clock out counts only the people who are actually on the clock;
//   5. a phone whose database has not applied the migration says so in a plain
//      sentence, and the roster behind it still works;
//   6. a foreman — who may read this page but never edit time on it — has no
//      checkboxes and no bar at all;
//   7. "Select all" ticks the people the SEARCH BOX is showing and nobody
//      else, so a supervisor looking at one filtered row cannot tick — and
//      then clock in — the whole company in two taps;
//   8. everybody who was ticked gets a line in the answer, INCLUDING the ones
//      the sheet deliberately never sent.
//
// The shifts and the crew are hand-built here rather than captured, because
// the whole point is a specific geometry: one person already on the target
// job, one on a different job, two off the clock.

import { expect, test, type Page, type Route } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";

/** The two fixture jobs this spec uses, by their real fixture ids. */
const OFFICE = "ebf64f94-0413-4434-aeb3-1aff228fb5b3"; // BLACK22
const OTHER = "3cc5b810-45e0-4445-a115-efa98f8efad3"; // OAKRIDGE

const ANA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const BEN = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const CARA = "cccccccc-3333-4333-8333-cccccccccccc";
const DAN = "dddddddd-4444-4444-8444-dddddddddddd";

const GENERAL = "11111111-aaaa-4aaa-8aaa-111111111111";
const INSTALL = "22222222-bbbb-4bbb-8bbb-222222222222";

const COST_CODES = [
  {
    id: GENERAL,
    code: "000",
    label: "General",
    description: null,
    active: true,
    sort_order: 5,
    is_general: true,
  },
  {
    id: INSTALL,
    code: "100",
    label: "Install — windows",
    description: null,
    active: true,
    sort_order: 10,
    is_general: false,
  },
];

function crew(role: string) {
  return [
    // The signed-in user. Named so the roster reads like a real one.
    {
      id: TEST_USER.id,
      display_name: "Marlene",
      skill_level: 5,
      role,
      active: true,
      language: "en",
      can_see_costs: false,
      can_see_pay: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    ...[
      [ANA, "Ana Ruiz"],
      [BEN, "Ben Cole"],
      [CARA, "Cara Diaz"],
      [DAN, "Dan Ortiz"],
    ].map(([id, name]) => ({
      id,
      display_name: name,
      skill_level: 3,
      role: "installer",
      active: true,
      language: "en",
      can_see_costs: false,
      can_see_pay: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    })),
  ];
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function openShift(
  id: string,
  profileId: string,
  projectId: string,
  jobCode: string,
  name: string,
) {
  return {
    id,
    profile_id: profileId,
    project_id: projectId,
    cost_code_id: INSTALL,
    clock_in_at: minutesAgo(90),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: minutesAgo(90),
    note: null,
    clocked_in_by: null,
    clocked_out_by: null,
    projects: { job_code: jobCode, name: jobCode },
    cost_codes: { code: "100", label: "Install — windows" },
    profiles: { display_name: name },
    editor: null,
    voider: null,
  };
}

// Ana is already on the job this spec clocks people INTO; Ben is on a
// different one; Cara and Dan are off the clock.
const SHIFTS = [
  openShift("11111111-1111-4111-8111-111111111111", ANA, OFFICE, "BLACK22", "Ana Ruiz"),
  openShift("22222222-2222-4222-8222-222222222222", BEN, OTHER, "OAKRIDGE", "Ben Cole"),
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

interface RpcCall {
  name: string;
  body: Record<string, unknown>;
}

/**
 * Registered AFTER useSupabaseFixtures so these win (Playwright favours the
 * most recently added route). Returns the list the RPC calls land in, so a
 * test can assert what actually left the phone.
 */
async function crewFixtures(page: Page, role: string): Promise<RpcCall[]> {
  const calls: RpcCall[] = [];
  const people = crew(role);

  await page.route("**/rest/v1/rpc/clock_in_many*", (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ name: "clock_in_many", body });
    const ids = (body.p_profile_ids as string[]) ?? [];
    return json(
      r,
      ids.map((id) => ({
        profile_id: id,
        // Ana is already there; everyone else is a fresh punch.
        outcome: id === ANA ? "already_on_this_job" : "clocked_in",
      })),
      ids.length,
    );
  });

  await page.route("**/rest/v1/rpc/clock_out_many*", (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ name: "clock_out_many", body });
    const ids = (body.p_profile_ids as string[]) ?? [];
    return json(
      r,
      ids.map((id) => ({ profile_id: id, outcome: "clocked_out" })),
      ids.length,
    );
  });

  await page.route("**/rest/v1/profiles**", (r) => {
    const url = new URL(r.request().url());
    const raw = url.searchParams.get("id");
    const id = raw?.startsWith("eq.") ? raw.slice(3) : null;
    const rows = id ? people.filter((p) => p.id === id) : people;
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, rows[0] ?? null, rows.length);
    return json(r, rows, rows.length);
  });

  await page.route("**/rest/v1/time_shifts**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, null, 0);
    return json(r, SHIFTS, SHIFTS.length);
  });

  await page.route("**/rest/v1/cost_codes**", (r) =>
    json(r, COST_CODES, COST_CODES.length),
  );
  // No per-job subset: the whole active library is pickable, which is every
  // job in this company today.
  await page.route("**/rest/v1/project_cost_codes**", (r) => json(r, [], 0));

  return calls;
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

/**
 * The rest of the roster's setup, once the caller has installed the shared
 * fixtures. Split this way on purpose: useSupabaseFixtures is `use`-prefixed,
 * so calling it from a named helper reads to the linter as a React hook in a
 * non-component — every other spec in this tree calls it from the test's own
 * arrow function, and so does each test below.
 */
async function openRoster(page: Page, role: "supervisor" | "foreman") {
  const calls = await crewFixtures(page, role);
  await page.goto("/team-timecards");
  await expect(page.getByText("Ana Ruiz")).toBeVisible();
  return calls;
}

/** Fill in the clock-in sheet, leaving the two checkboxes to the caller. */
async function openClockInSheet(page: Page) {
  await page.getByRole("button", { name: "Clock in…" }).click();
  const sheet = page.locator(".modal-card");
  await expect(sheet).toBeVisible();
  await sheet.locator("#crewclock-job").selectOption(OFFICE);
  await expect(sheet.locator("#crewclock-code option")).toHaveCount(3);
  await sheet.locator("#crewclock-code").selectOption(INSTALL);
  return sheet;
}

test("a supervisor ticks three people and clocks them in, in one request", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const calls = await openRoster(page, "supervisor");

  await page.getByLabel("Select Ana Ruiz").check();
  await page.getByLabel("Select Cara Diaz").check();
  await page.getByLabel("Select Dan Ortiz").check();
  await expect(page.locator(".crewclock-bar")).toContainText("3 selected");

  const sheet = await openClockInSheet(page);
  await sheet.getByText("I gave today's toolbox talk to everyone selected").click();
  await sheet.getByRole("button", { name: "Clock them in" }).click();

  // ONE request, carrying exactly what the sheet was set to.
  await expect.poll(() => calls.length).toBe(1);
  const body = calls[0].body;
  expect(calls[0].name).toBe("clock_in_many");
  expect((body.p_profile_ids as string[]).slice().sort()).toEqual(
    [ANA, CARA, DAN].slice().sort(),
  );
  expect(body.p_project_id).toBe(OFFICE);
  expect(body.p_cost_code_id).toBe(INSTALL);
  expect(body.p_talk_attested).toBe(true);
  expect(body.p_move_if_elsewhere).toBe(false);

  // And the answer is per person, in plain English.
  await expect(sheet.getByText("What happened")).toBeVisible();
  await expect(sheet.getByText("Already on this job")).toHaveCount(1);
  await expect(sheet.getByText("Clocked in", { exact: true })).toHaveCount(2);
});

test("no toolbox attestation, no clock-in", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await openRoster(page, "supervisor");
  await page.getByLabel("Select Cara Diaz").check();

  const sheet = await openClockInSheet(page);
  // Job and cost code are set; the only thing missing is the claim that the
  // talk was actually given, and that alone holds the button.
  const go = sheet.getByRole("button", { name: "Clock them in" });
  await expect(go).toBeDisabled();
  await sheet.getByText("I gave today's toolbox talk to everyone selected").click();
  await expect(go).toBeEnabled();
});

test("somebody already on another job is left alone until Move is ticked", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const calls = await openRoster(page, "supervisor");
  await page.getByLabel("Select Ben Cole").check();
  await page.getByLabel("Select Cara Diaz").check();

  const sheet = await openClockInSheet(page);
  await sheet.getByText("I gave today's toolbox talk to everyone selected").click();

  // Ben is on OAKRIDGE. He is named, and he is not in the request.
  await expect(sheet.getByText(/left where they are/)).toContainText("Ben Cole");
  await sheet.getByRole("button", { name: "Clock them in" }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].body.p_profile_ids).toEqual([CARA]);

  // Two names were ticked, so TWO lines come back. The server only heard about
  // one of them; the screen accounts for the other rather than leaving a
  // supervisor to notice a missing row (2026-09-04 review).
  await expect(sheet.getByText("What happened")).toBeVisible();
  await expect(sheet.locator("li")).toHaveCount(2);
  await expect(sheet.locator("li", { hasText: "Ben Cole" })).toContainText(
    "Left on their other job",
  );
  await expect(sheet.locator("li", { hasText: "Cara Diaz" })).toContainText(
    "Clocked in",
  );

  // Tick Move, and he goes with them. (Closing the result list clears the
  // selection — a done action should not leave fourteen boxes still ticked —
  // so the two of them are picked again first.)
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Select Ben Cole")).not.toBeChecked();
  await page.getByLabel("Select Ben Cole").check();
  await page.getByLabel("Select Cara Diaz").check();
  await page.getByRole("button", { name: "Clock in…" }).click();
  const again = page.locator(".modal-card");
  await again.locator("#crewclock-job").selectOption(OFFICE);
  await again.locator("#crewclock-code").selectOption(INSTALL);
  await again.getByText("I gave today's toolbox talk to everyone selected").click();
  await again.getByText("Move anyone already on another job here").click();
  await expect(again.getByText(/left where they are/)).toHaveCount(0);
  await again.getByRole("button", { name: "Clock them in" }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect((calls[1].body.p_profile_ids as string[]).slice().sort()).toEqual(
    [BEN, CARA].slice().sort(),
  );
  expect(calls[1].body.p_move_if_elsewhere).toBe(true);
});

test("clock out counts only the people actually on the clock", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const calls = await openRoster(page, "supervisor");
  await page.getByLabel("Select Ana Ruiz").check();
  await page.getByLabel("Select Ben Cole").check();
  await page.getByLabel("Select Cara Diaz").check();

  await page.getByRole("button", { name: "Clock out…" }).click();
  const sheet = page.locator(".modal-card");
  // Three ticked, two on the clock — the sheet says what it is really about.
  await expect(sheet.getByText("Clock out 2 people")).toBeVisible();
  await sheet.getByRole("button", { name: "Clock them out" }).click();

  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].name).toBe("clock_out_many");
  expect((calls[0].body.p_profile_ids as string[]).slice().sort()).toEqual(
    [ANA, BEN].slice().sort(),
  );
  await expect(sheet.getByText("Clocked out", { exact: true })).toHaveCount(2);
});

test("a phone whose database has not caught up says so, and the roster still works", async ({
  page,
}) => {
  // The frontend and the backend deploy as separate workflows, and the backend
  // one has silently failed before, so "the app is live and the migration is
  // not" is a state that really happens. PGRST202 is exactly what the live
  // project answered when this branch was probed (2026-09-04).
  await useSupabaseFixtures(page, { role: "supervisor" });
  await openRoster(page, "supervisor");
  await page.route("**/rest/v1/rpc/clock_out_many*", (r) =>
    r.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        code: "PGRST202",
        message:
          "Could not find the function public.clock_out_many(p_profile_ids) in the schema cache",
      }),
    }),
  );

  await page.getByLabel("Select Ana Ruiz").check();
  await page.getByRole("button", { name: "Clock out…" }).click();
  const sheet = page.locator(".modal-card");
  await sheet.getByRole("button", { name: "Clock them out" }).click();

  // A plain sentence, not a schema-cache error — and the roster behind it is
  // untouched.
  await expect(sheet.getByText(/isn't switched on yet/)).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Ana Ruiz")).toBeVisible();
});

test("Select all ticks what the search box is showing, and nothing else", async ({
  page,
}) => {
  // The roster is five people. Filtered to one, "Select all" must mean "all of
  // these" — the alternative is two taps between a supervisor looking up one
  // name and the entire company being clocked into one job.
  await useSupabaseFixtures(page, { role: "supervisor" });
  await openRoster(page, "supervisor");
  await expect(page.getByRole("button", { name: "Select all (5)" })).toBeVisible();

  await page.getByPlaceholder("Search the crew…").fill("Ben");
  await expect(page.getByLabel("Select Ana Ruiz")).toHaveCount(0);
  // The button says the number it would tick, so it cannot lie about it.
  const selectAll = page.getByRole("button", { name: "Select all (1)" });
  await expect(selectAll).toBeVisible();
  await selectAll.click();
  await expect(page.locator(".crewclock-bar")).toContainText("1 selected");

  // Clearing the search shows the other four, still unticked.
  await page.getByPlaceholder("Search the crew…").fill("");
  await expect(page.getByLabel("Select Ben Cole")).toBeChecked();
  await expect(page.getByLabel("Select Ana Ruiz")).not.toBeChecked();
  await expect(page.locator(".crewclock-bar")).toContainText("1 selected");

  // And a second search ADDS rather than replacing: the name found first is
  // never quietly unticked by the next one.
  await page.getByPlaceholder("Search the crew…").fill("Cara");
  await page.getByRole("button", { name: "Select all (1)" }).click();
  await expect(page.locator(".crewclock-bar")).toContainText("2 selected");
});

test("a foreman reads the roster and cannot clock anybody", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await openRoster(page, "foreman");
  // Q3's line: every time EDIT is supervisor+, and starting somebody's punch
  // is an edit to their pay. No checkboxes, no bar, nothing to mis-tap.
  await expect(page.getByLabel("Select Ana Ruiz")).toHaveCount(0);
  await expect(page.locator(".crewclock-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Select all/ })).toHaveCount(0);
});

// Wave S: THE WALL's frontend half, end to end.
//
// Server-side RLS (20260950000000_partner_wall.sql) is the real wall — a
// partner cannot read a crew table no matter what the client renders. What
// this file proves is the OTHER half: that a partner-flagged session never
// even gets a chance to look, because RequirePartnerElsewhere redirects it
// to /stg before the crew Layout (and its nav) ever mounts (THE WALL #5),
// and that the /stg screens render exactly what the projection RPCs hand
// them (THE WALL #4, S3).
//
// Same fixture idiom as daily-logs.spec.ts: useSupabaseFixtures called
// directly inside each test (not factored into a shared wrapper — oxlint's
// react-hooks rule treats its "use"-prefixed name as a real hook and
// refuses to let anything but a component or another hook call it, the
// same reason every existing spec in this suite repeats the call rather
// than wrapping it), then page.route() overrides registered afterward (so
// they win) for the RPCs this wave adds. A "partner" is not a
// FixtureOptions role — THE WALL pins a partner's profiles.role to
// 'installer' (rank stops mattering the moment is_partner is true), so the
// ONLY thing that makes a fixture session a partner is is_partner_user()
// answering true.
import { expect, test, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * The e2e fixture host (playwright.config.ts) legitimately and correctly
 * mismatches the real Supabase project, so WrongProjectBanner's real,
 * non-dismissable "Wrong database" alert (position: fixed, near the top of
 * the viewport, z-index 90 — above this compact page's own header) renders
 * on every page in this suite. It never appears in production. An
 * initScript, not a post-navigation style tag: it has to exist before the
 * app's own first paint, or the banner blocks a click before this script
 * would get a chance to run.
 */
async function hideWrongProjectBanner(page: Parameters<typeof useSupabaseFixtures>[0]) {
  await page.addInitScript(() => {
    // Deferred to DOMContentLoaded, not appended immediately: an initScript
    // runs at document_start, before the parser has created <html>/<head> —
    // document.documentElement is still null there, so an immediate
    // appendChild throws (silently, since Playwright doesn't surface an
    // initScript's own exceptions) and the banner is never actually hidden.
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        const style = document.createElement("style");
        style.textContent = ".pwa-banner-wrong-project { display: none !important; }";
        document.head.appendChild(style);
      },
      { once: true },
    );
  });
}

/** Mocks is_partner_user() answering true — the ONE thing that makes a
 * fixture session read as a partner (never a FixtureOptions role). */
async function mockIsPartnerUser(page: Parameters<typeof useSupabaseFixtures>[0]) {
  await page.route("**/rest/v1/rpc/is_partner_user", (route) => json(route, true));
}

test("a partner-role fixture visiting crew routes lands on /stg, with zero crew chrome", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await mockIsPartnerUser(page);
  // Left as the shared fixture router's own default (unmatched -> null),
  // which lib/stg.ts's `?? []` / EMPTY_DAY already treat as "nothing yet" —
  // this test is about the REDIRECT, not any particular STG payload.

  for (const path of ["/warehouse", "/projects", "/team-timecards"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/stg\/?$/);
    // The wordmark is the ONLY thing a partner ever sees — no crew nav
    // label anywhere on the page, from either the warehouse route's own
    // chrome or the Layout it would have carried.
    await expect(page.getByText("STG Windows & Doors")).toBeVisible();
    await expect(page.getByRole("link", { name: "Warehouse" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Jobs" })).toHaveCount(0);
  }
});

test("a crew (non-partner) fixture is never redirected away from its own routes", async ({ page }) => {
  // The negative of the negative: THE WALL must not fire for everyone.
  // is_partner_user left unmocked falls through to the shared fixture
  // router's rpc default, which answers `null` — falsy, so useIsPartnerUser
  // (lib/stg.ts) resolves to `false` and RequirePartnerElsewhere renders
  // Layout normally.
  await useSupabaseFixtures(page, { role: "foreman" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/projects**", (route) => json(route, []));

  await page.goto("/projects");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText("STG Windows & Doors")).toHaveCount(0);
});

test("stg_day's payload renders through exactly, and is asked for the tapped job", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await mockIsPartnerUser(page);

  const JOB = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Riverside Remodel",
    job_code: "RIV01",
    status: "active",
    progress_percent: 42,
    window_start: "2026-08-01",
    window_end: "2026-08-20",
  };
  await page.route("**/rest/v1/rpc/stg_job_list", (route) => json(route, [JOB]));
  await page.route("**/rest/v1/rpc/stg_calendar", (route) => json(route, []));

  const DAY_PAYLOAD = {
    worked: true,
    crew_names: ["Sam Rivera", "Alex Chen"],
    total_hours: 14.5,
    units_finished: 3,
    log: { headline: "Great progress", notes: "Finished the west wall.", day_flow: "smooth" },
  };
  let calledWith: Record<string, unknown> | null = null;
  await page.route("**/rest/v1/rpc/stg_day", async (route) => {
    calledWith = route.request().postDataJSON() as Record<string, unknown>;
    await json(route, DAY_PAYLOAD);
  });

  await page.goto("/stg");
  await expect(page.getByText("Riverside Remodel")).toBeVisible();

  await page.getByRole("button", { name: "Calendar" }).click();
  // Exactly one granted job, so tapping any day (today's cell) opens its
  // panel directly — no job chooser to navigate first.
  await page.locator('[data-today="true"]').click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => calledWith).not.toBeNull();
  expect(calledWith).toMatchObject({ p_project: JOB.id });
  expect(String(calledWith!.p_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // System facts, rendered verbatim from the RPC's own field names.
  await expect(page.getByText("Sam Rivera, Alex Chen")).toBeVisible();
  await expect(page.getByText("14.5 hours logged · 3 units finished")).toBeVisible();
  // The log block: exactly {headline, notes, day_flow} — never reflection,
  // never filed_by, and this component never re-derives the gate itself.
  await expect(page.getByText("Great progress")).toBeVisible();
  await expect(page.getByText("Finished the west wall.")).toBeVisible();
  await expect(page.getByText("Smooth")).toBeVisible();
});

test("stg_day's log block falls back honestly when the RPC withholds it", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await mockIsPartnerUser(page);

  const JOB = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Cedar Park Addition",
    job_code: "CDR02",
    status: "active",
    progress_percent: 10,
    window_start: null,
    window_end: null,
  };
  await page.route("**/rest/v1/rpc/stg_job_list", (route) => json(route, [JOB]));
  await page.route("**/rest/v1/rpc/stg_calendar", (route) => json(route, []));
  // Worked, but the coverage gate (or the share toggle) kept log null —
  // this component must show the plain fallback, never guess why.
  await page.route("**/rest/v1/rpc/stg_day", (route) =>
    json(route, { worked: true, crew_names: ["Jordan Lee"], total_hours: 8, units_finished: 0, log: null }),
  );

  await page.goto("/stg");
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.locator('[data-today="true"]').click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Jordan Lee")).toBeVisible();
  await expect(page.getByText("No notes shared for this day yet.")).toBeVisible();
});

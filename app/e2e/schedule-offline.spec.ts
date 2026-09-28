// The Schedule tab (crew redesign K1.6, the owner's design): a week on
// opening, more on demand, and — the rule this spec exists for — never
// "no work" for a phone that has no signal.

import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures } from "./support/release1Fixtures";
import { measureCrewRule } from "./support/crewRule";

test.use({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });

test("opens on today + 7 days with Start work on today, Updated and Changed; Show more keeps going", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const ranges: string[] = [];
  await morningFixtures(page);
  // Record every window the tab asks for, on top of the fixture's answer.
  // listMyPublished asks for start_date <= to and end_date >= from.
  await page.route("**/rest/v1/schedule_assignments**", async (r) => {
    const url = new URL(r.request().url());
    const from = (url.searchParams.get("end_date") ?? "").replace("gte.", "");
    const to = (url.searchParams.get("start_date") ?? "").replace("lte.", "");
    ranges.push(`${from}|${to}`);
    await r.fallback();
  });
  await page.goto("/my-schedule");
  const screen = page.getByTestId("schedule-screen");
  await expect(screen).toBeVisible();
  await expect(screen.locator('[data-testid="schedule-entry"]')).toHaveCount(2);
  await expect(screen).toContainText("Oakridge Apartments Bldg C");
  await expect(screen).toContainText("Starts 7:00 AM");
  await expect(screen).toContainText("Updated");
  await expect(screen).toContainText("Changed");
  await expect(screen.getByTestId("schedule-start-work")).toBeVisible();
  await expect(screen).toContainText("Black Desert");
  // The first window is seven days.
  const span = (range: string) => {
    const [from, to] = range.split("|");
    return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400_000);
  };
  expect(span(ranges[0])).toBe(7);
  await screen.getByTestId("schedule-more").click();
  await expect.poll(() => ranges.length).toBeGreaterThan(1);
  expect(span(ranges.at(-1)!)).toBe(21);
  // K-X4 on this screen too.
  const report = await measureCrewRule(page, '[data-testid="schedule-screen"]');
  expect(report.smallTargets).toEqual([]);
  expect(report.smallText).toEqual([]);
  expect(report.lowContrast).toEqual([]);
});

test("offline with a saved copy: shows the copy, says when it is from — never 'no work'", async ({ page, context }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page);
  // Load Work and the Schedule tab once while online: Work reads the same
  // week the tab opens on, and the tab's chunk is on the phone (a real
  // phone has it precached by the service worker; the e2e run has no worker).
  await page.goto("/");
  await expect(page.getByTestId("ws-today")).toContainText("Oakridge Apartments Bldg C");
  await page.getByRole("navigation", { name: "Main" }).getByText("Schedule").click();
  await expect(page.getByTestId("schedule-screen")).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByText("Work").click();
  await expect(page.getByTestId("ws-today")).toBeVisible();
  await context.setOffline(true);
  await page.getByRole("navigation", { name: "Main" }).getByText("Schedule").click();
  const screen = page.getByTestId("schedule-screen");
  await expect(screen).toBeVisible();
  await expect(screen.locator('[data-testid="schedule-entry"]')).toHaveCount(2);
  await expect(screen.getByTestId("schedule-saved")).toContainText(/Showing your schedule from .* — can't reach Forge/);
  await expect(screen).not.toContainText("Nothing published");
  await expect(screen).not.toContainText("no work");
  await context.setOffline(false);
});

test("offline with nothing saved: says it cannot reach Forge — never 'nothing scheduled'", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page);
  await page.route("**/rest/v1/schedule_assignment_members**", (r) => r.abort("internetdisconnected"));
  await page.goto("/my-schedule");
  const screen = page.getByTestId("schedule-screen");
  await expect(screen.getByTestId("schedule-unreachable")).toContainText("Can't reach Forge");
  await expect(screen).not.toContainText("Nothing published");
});

test("a foreman gets a view-only Crew switch; editing stays in Scheduling", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page);
  await page.goto("/my-schedule");
  const screen = page.getByTestId("schedule-screen");
  await screen.getByTestId("schedule-crew").click();
  await expect(screen).toContainText("edit in Scheduling");
  await expect(screen.locator('[data-testid="schedule-entry"]').first()).toBeVisible();
  await expect(screen.getByTestId("schedule-start-work")).toHaveCount(0);
  await expect(screen.getByRole("link", { name: /edit in Scheduling/ })).toHaveAttribute("href", /\/scheduling/);
});

test("the classic My Schedule (F2) no longer shows the error AND 'Nothing scheduled' together", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page);
  await page.route("**/rest/v1/schedule_assignment_members**", (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }),
  );
  await page.goto("/my-schedule");
  await expect(page.getByText("Couldn't load your schedule")).toBeVisible();
  await expect(page.getByText("Nothing scheduled yet")).toHaveCount(0);
  void json;
});

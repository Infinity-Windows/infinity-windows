// The Work screen (crew redesign K1.2 / K1.4 / K1.9) on a 375×667 phone —
// the smallest screen the redesign is measured against — plus the crew
// screen rule (K-X4) measured on what actually rendered.

import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures } from "./support/release1Fixtures";
import { measureCrewRule } from "./support/crewRule";

test.use({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });

test("items 1–3 — clock, today, your unit — are visible without scrolling, in order", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, openShift: true, myOpening: true });
  await page.goto("/");
  const clock = page.getByTestId("ws-clock");
  const today = page.getByTestId("ws-today");
  const unit = page.getByTestId("ws-unit");
  const quick = page.getByTestId("ws-quick");
  await expect(clock).toBeVisible();
  await expect(today).toBeVisible();
  await expect(unit).toBeVisible();
  const [c, t, u] = await Promise.all([clock.boundingBox(), today.boundingBox(), unit.boundingBox()]);
  expect(c!.y).toBeLessThan(t!.y);
  expect(t!.y).toBeLessThan(u!.y);
  // Item 3's bottom edge sits inside the 667px viewport without a scroll.
  expect(u!.y + u!.height).toBeLessThanOrEqual(667);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(quick).toBeVisible();
  // No horizontal scroll at 375px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "e2e/__screenshots__/release1-work-on-clock.png" });
});

test("on the clock: the badge in the top bar, Today's facts, Next up from the plan, four quick buttons", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, openShift: true, myOpening: true });
  await page.goto("/");
  await expect(page.getByTestId("clock-badge")).toContainText("Clocked in");
  const clock = page.getByTestId("ws-clock");
  // The strip carries the code on its one status row; the full name is on
  // the Today card and in the code's tooltip.
  await expect(clock).toContainText("OAKRIDGE");
  await expect(clock.locator(".ws-clock-job")).toHaveAttribute("title", "OAKRIDGE · Oakridge Apartments Bldg C");
  const today = page.getByTestId("ws-today");
  await expect(today).toContainText("Oakridge Apartments Bldg C");
  await expect(today).toContainText("Starts 7:00 AM");
  await expect(today).toContainText("With Sam");
  await expect(today).toContainText("Updated");
  await expect(today).toContainText("Changed");
  await expect(today.getByRole("button", { name: /Get directions/ })).toBeVisible();
  const unit = page.getByTestId("ws-unit");
  await expect(unit).toContainText("Next up");
  await expect(unit).toContainText("Assigned to you");
  await expect(unit).toContainText("W7");
  await expect(page.getByTestId("ws-unit-start")).toBeEnabled();
  const quick = page.getByTestId("ws-quick");
  for (const label of ["Prep time", "Take supplies", "Daily log", "Report a problem"]) {
    await expect(quick.getByRole("button", { name: label })).toBeVisible();
  }
  // The badge opens the clock sheet — break and clock-out from any screen.
  await page.getByTestId("clock-badge").click();
  await expect(page.locator(".clock-sheet")).toBeVisible();
  await expect(page.locator(".clock-sheet")).toContainText("Go on break");
  // The classic landing's first-run tip ("Tap Clock to start your shift")
  // would be wrong here, and the values strip is not this screen's job.
  await expect(page.getByText("Tap Clock to start your shift")).toHaveCount(0);
  await expect(page.locator(".core-values-strip, .values-strip")).toHaveCount(0);
});

test("K-X4: every target ≥48px (primary 56), every text ≥16px, sunlight contrast — measured", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: false, openShift: true, myOpening: true });
  await page.goto("/");
  await expect(page.getByTestId("ws-unit")).toBeVisible();
  const report = await measureCrewRule(page, '[data-testid="work-screen"]');
  expect(report.targetsMeasured).toBeGreaterThan(8);
  expect(report.textMeasured).toBeGreaterThan(15);
  expect(report.smallTargets, "tap targets under 48px").toEqual([]);
  expect(report.smallText, "text under 16px").toEqual([]);
  expect(report.lowContrast, "text under 4.5:1").toEqual([]);

  // Foreman: the Jobs row is on Work (K1.1) and measured too.
  await page.getByRole("button", { name: "Report a problem" }).click();
  const sheet = page.getByRole("dialog", { name: "Report a problem" });
  await expect(sheet).toBeVisible();
  const sheetReport = await measureCrewRule(page, '[role="dialog"][aria-label="Report a problem"]');
  expect(sheetReport.smallTargets).toEqual([]);
  expect(sheetReport.smallText).toEqual([]);
});

test("Spanish: the whole Work screen reads in Spanish, no English fallback", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman", uiDesign: "new", language: "es" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, openShift: true, myOpening: true });
  await page.goto("/");
  await expect(page.getByTestId("ws-clock")).toContainText("Entrada");
  await expect(page.getByTestId("ws-today")).toContainText("Hoy");
  await expect(page.getByTestId("ws-unit")).toContainText("Lo que sigue");
  const quick = page.getByTestId("ws-quick");
  await expect(quick).toContainText("Tiempo de preparación");
  await expect(quick).toContainText("Tomar material");
  await expect(quick).toContainText("Reportar un problema");
  await expect(page.getByTestId("ws-lead")).toContainText("Trabajos");
  const bar = page.getByRole("navigation", { name: "Main" });
  await expect(bar).toContainText("Trabajo");
  await expect(bar).toContainText("Horario");
  await expect(bar).toContainText("Más");
});

test("foreman: Jobs, Team timecards on Work; supervisor adds Overview", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page);
  await page.goto("/");
  const lead = page.getByTestId("ws-lead");
  await expect(lead.getByRole("link", { name: "Jobs" })).toBeVisible();
  await expect(lead.getByRole("link", { name: "Team timecards" })).toBeVisible();
  await expect(lead.getByRole("link", { name: "Overview" })).toBeVisible();
});

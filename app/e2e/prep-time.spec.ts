// Prep time (crew redesign K1.5): one tap from Work, a reason, and the same
// record Current Work's idle timer always wrote — the stored stage is still
// "Idle time"; only the words on screen moved, in both languages.

import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures, OAKRIDGE } from "./support/release1Fixtures";

test.use({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });

test("Prep time → Hauling → Start records a non-unit session with the reason, and shows it running", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: true, openShift: true });
  await page.goto("/");
  await page.getByTestId("ws-quick-prep").click();
  const sheet = page.getByRole("dialog", { name: "Prep time" });
  await expect(sheet).toBeVisible();
  for (const reason of ["Gathering", "Hauling", "Setup", "Errand", "Cleanup", "Other"]) {
    await expect(sheet.getByRole("button", { name: reason, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("ws-prep-start")).toBeDisabled();
  await sheet.getByRole("button", { name: "Hauling", exact: true }).click();
  await page.getByTestId("ws-prep-start").click();
  await expect.poll(() => world.workCommands.length).toBe(1);
  const cmd = world.workCommands[0] as { p_action: string; p_data: Record<string, unknown> };
  expect(cmd.p_action).toBe("start");
  expect(cmd.p_data.unit_id).toBeNull();
  expect(cmd.p_data.stage).toBe("Idle time");
  expect(cmd.p_data.description).toBe("Hauling");
  expect(cmd.p_data.project_id).toBe(OAKRIDGE);
  await expect(sheet).toHaveCount(0);
});

test("off the clock the button says to start your day rather than opening a dead end", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true });
  await page.goto("/");
  await page.getByTestId("ws-quick-prep").click();
  await expect(page.getByRole("dialog", { name: "Prep time" })).toHaveCount(0);
  await expect(page.getByText("Start your day to record prep time.")).toBeVisible();
});

test("Spanish: one term, Tiempo de preparación, on Work, on the sheet and on the classic Current Work", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new", language: "es" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, openShift: true });
  await page.goto("/");
  await page.getByTestId("ws-quick-prep").click();
  const sheet = page.getByRole("dialog", { name: "Tiempo de preparación" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Acarreando");
  await expect(page.locator("body")).not.toContainText("Tiempo indirecto");
  await expect(page.locator("body")).not.toContainText("Tiempo entre unidades");
  await sheet.getByRole("button", { name: "Cancelar" }).click();
  await page.goto("/current-work");
  await expect(page.getByRole("button", { name: "Tiempo de preparación" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Idle time");
});

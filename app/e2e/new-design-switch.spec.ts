// The design switch (crew redesign K-X2, the owner's rollout, 2026-09-23):
// everybody gets the option, the classic screens stay, the owner can turn
// the new design off for everyone at once.

import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures } from "./support/release1Fixtures";

test.use({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });

test("classic by default: the old landing, the old bar, and a one-time Try the new Forge card", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page);
  await page.goto("/");
  // The classic installer landing and bar are exactly what they were.
  await expect(page.locator(".clockin-block")).toBeVisible();
  const bar = page.getByRole("navigation", { name: "Main" });
  await expect(bar.getByText("Today")).toBeVisible();
  await expect(bar.getByText("Clock")).toBeVisible();
  await expect(page.locator(".ask-fab")).toBeVisible();
  // The invitation, once.
  const card = page.getByRole("region", { name: "Try the new Forge" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Not now" }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".clockin-block")).toBeVisible();
  await expect(page.getByRole("region", { name: "Try the new Forge" })).toHaveCount(0);
});

test("the person's own choice switches the whole front door, and back", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page);
  await page.goto("/");
  // New design: Work lands, the bar is Work · Schedule · (+) · Ask · More,
  // no Clock tab, no floating Ask.
  await expect(page.getByTestId("work-screen")).toBeVisible();
  const bar = page.getByRole("navigation", { name: "Main" });
  await expect(bar.getByText("Work")).toBeVisible();
  await expect(bar.getByText("Schedule")).toBeVisible();
  await expect(bar.getByText("Ask")).toBeVisible();
  await expect(bar.getByText("More")).toBeVisible();
  await expect(bar.getByText("Clock")).toHaveCount(0);
  await expect(page.locator(".ask-fab")).toHaveCount(0);
  await expect(page.locator(".clockin-block")).toHaveCount(0);

  // Switch back from Settings: one tap, the same record set either way.
  await page.goto("/settings");
  await page.getByRole("button", { name: "Use the classic design" }).click();
  expect(world.designWrites).toEqual(["classic"]);
  await page.goto("/");
  await expect(page.locator(".clockin-block")).toBeVisible();
  await expect(page.getByTestId("work-screen")).toHaveCount(0);
});

test("the owner's master switch off sends a person who chose the new design back to classic", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { newDesignOn: false });
  await page.goto("/");
  await expect(page.locator(".clockin-block")).toBeVisible();
  await expect(page.getByTestId("work-screen")).toHaveCount(0);
  // And Settings says so instead of showing a switch that does nothing.
  await page.goto("/settings");
  await expect(page.getByText("turned the new design off for everyone")).toBeVisible();
});

test("the owner sees the master switch and the paid-time date; an installer does not", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner" });
  await hideWrongProjectBanner(page);
  await morningFixtures(page);
  await page.goto("/settings");
  await expect(page.getByText("New design master switch")).toBeVisible();
  await expect(page.getByText("Paid time starts at Start day")).toBeVisible();
  await expect(page.getByText("Off — today's timing applies.")).toBeVisible();
});

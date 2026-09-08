import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const TRIP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
async function tripFixture(page: Page, status = "published") {
  await page.route("**/rest/v1/trips**", r => json(r, {
    id: TRIP_ID, name: "Fixture crew trip", destination: "Fixture job",
    start_date: "2026-09-01", end_date: "2099-09-19", status,
    timezone: "America/Denver", notes: "Meet the crew at the shop.",
    trip_crew: [{ profile_id: TEST_USER.id, role: "crew", profiles: { display_name: "Fixture crew" } }],
  }, 1));
  await page.route("**/rest/v1/flights**", r => json(r, [
    { id: "mine", trip_id: TRIP_ID, profile_id: TEST_USER.id, airline: "Crew airline", flight_number: "123", minutes_before_departure: 120, sort_order: 0 },
    { id: "other", trip_id: TRIP_ID, profile_id: "someone-else", airline: "Private airline", flight_number: "456", minutes_before_departure: 120, sort_order: 1 },
  ], 2));
  await page.route("**/rest/v1/lodging**", r => json(r, [{
    id: "house", trip_id: TRIP_ID, name: "Crew house", address: "123 Fixture Road",
    entry_steps: "Use the side entrance beside the garage.", wifi_ssid: "Fixture guest",
    door_code: "123456", parking: "Park in the driveway.", sort_order: 0,
  }], 1));
  await page.route("**/rest/v1/ground_transport**", r => json(r, [], 0));
  await page.route("**/rest/v1/procedures**", r => json(r, [{
    id: "rule", trip_id: TRIP_ID, title: "Before leaving", body: "Lock the side door.", sort_order: 0,
  }], 1));
  await page.route("**/rest/v1/trip_contacts**", r => json(r, [{
    id: "host", trip_id: TRIP_ID, name: "Fixture host", phone: "+18015550123", sort_order: 0,
  }], 1));
  await page.route("**/rest/v1/trip_attachments**", r => json(r, [], 0));
}

for (const width of [375, 1280]) {
  test(`trip details stay on one sheet with usable jumps at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "installer" });
    await tripFixture(page);
    await page.goto(`/travel/${TRIP_ID}`);
    const jumps = page.getByRole("navigation", { name: "Trip sections" });
    await expect(jumps).toBeVisible();
    for (const id of ["timeline", "flights", "lodging", "ground", "rules", "contacts"]) {
      await expect(page.locator(`#trip-${id}`)).toBeVisible();
    }
    await expect(page.locator(".travel-detail [role=tab]")).toHaveCount(0);
    await expect(page.getByText("Private airline", { exact: false })).toHaveCount(0);
    await expect(page.locator("#trip-lodging")).toContainText("Crew house");
    await expect(page.locator("#trip-lodging")).toContainText("Use the side entrance");
    await expect(page.getByRole("button", { name: "Publish to crew" })).toHaveCount(0);
    await jumps.getByRole("link", { name: "Contacts", exact: true }).click();
    await expect(page).toHaveURL(/#trip-contacts$/);
    await expect(page.getByRole("link", { name: "Call", exact: true }).last()).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const sizes = await jumps.getByRole("link").evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
    expect(sizes.every(h => h >= 44)).toBe(true);
    // The fixture-only host intentionally triggers this production safeguard.
    // Hide it for the screenshot only; leave it active during every interaction.
    await page.screenshot({ path: `e2e/test-results/trip-sheet-${width}.png`, fullPage: true,
      style: ".pwa-banner-wrong-project { visibility: hidden !important; }" });
  });
}

test("Spanish trip navigation and the crew draft boundary", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", language: "es" });
  await tripFixture(page);
  await page.goto(`/travel/${TRIP_ID}`);
  await expect(page.getByRole("navigation", { name: "Secciones del viaje" })).toBeVisible();
  await page.getByRole("link", { name: "Hospedaje", exact: true }).click();
  await expect(page).toHaveURL(/#trip-lodging$/);
  await tripFixture(page, "draft");
  await page.reload();
  await expect(page.getByRole("heading", { name: "No se encontró el viaje" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Secciones del viaje" })).toHaveCount(0);
  await expect(page.getByText("Crew house", { exact: true })).toHaveCount(0);
});

test("a supervisor can review and edit lodging from the continuous draft", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await tripFixture(page, "draft");
  await page.goto(`/travel/${TRIP_ID}`);
  await expect(page.locator("#trip-publish").getByRole("button", { name: "Publish to crew" })).toBeVisible();
  await page.locator("#trip-lodging").getByRole("button", { name: /edit lodging/i }).click();
  await expect(page.locator(".travel-sheet")).toBeVisible();
  const editor = page.getByRole("dialog", { name: "Edit lodging" });
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Crew house");
  await editor.getByLabel("Name", { exact: true }).fill("Unsaved house edit");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator("#trip-lodging")).toContainText("Crew house");
  await expect(page.locator("#trip-lodging")).not.toContainText("Unsaved house edit");
});

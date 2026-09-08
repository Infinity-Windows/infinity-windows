import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

for (const width of [375, 1280]) {
  test(`display modes persist and keep navigation reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "supervisor" });
    await page.goto("/settings");
    const picker = page.getByRole("combobox", { name: "Display view" });
    await expect(picker).toHaveValue("auto");
    await expect(page.locator("html")).toHaveAttribute("data-display-layout", width < 860 ? "phone" : "desktop");
    await picker.selectOption("phone");
    await expect(page.locator(".app-rail")).not.toBeVisible();
    await expect(page.locator(".tabbar")).toBeVisible();
    await page.reload();
    await expect(picker).toHaveValue("phone");
    expect(await page.locator(".page").evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(640);
    await picker.selectOption("desktop");
    await expect(page.locator("html")).toHaveAttribute("data-display-layout", "desktop");
    await expect(picker).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await picker.selectOption("auto");
    await page.setViewportSize({ width: width < 860 ? 1280 : 375, height: 844 });
    await expect(page.locator("html")).toHaveAttribute("data-display-layout", width < 860 ? "desktop" : "phone");
  });
}

test("phone agenda switches to the board and preserves an open plan draft", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await page.route("**/rest/v1/schedule_assignments**", r => json(r, [], 0));
  await page.goto("/scheduling");
  const picker = page.getByRole("combobox", { name: "Display view" });
  await expect(page.getByRole("tab", { name: "Agenda", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: /Plan work on/ }).click();
  const note = page.getByPlaceholder("e.g. bring the big ladder");
  await note.fill("Keep the ladder in truck 3");
  // A second tab changing the device preference must not recreate this editor.
  await page.evaluate(() => {
    localStorage.setItem("infinity.display-mode", "desktop");
    window.dispatchEvent(new StorageEvent("storage", { key: "infinity.display-mode", newValue: "desktop" }));
  });
  await expect(note).toHaveValue("Keep the ladder in truck 3");
  // The fixture-only wrong-project banner overlays the top edge. Exercise keyboard activation.
  const close = page.locator(".sched-sheet").getByRole("button", { name: "Close", exact: true });
  await close.focus();
  await close.press("Enter");
  await expect(page.getByRole("tab", { name: "Board", exact: true })).toHaveAttribute("aria-selected", "true");
  await picker.selectOption("phone");
  await expect(page.getByRole("tab", { name: "Agenda", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Spanish display choices work with blocked storage", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", language: "es" });
  await page.goto("/settings");
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("blocked"); }; });
  const picker = page.getByRole("combobox", { name: "Vista de pantalla" });
  await picker.selectOption("phone");
  await expect(picker).toHaveValue("phone");
  await expect(page.locator("html")).toHaveAttribute("data-display-layout", "phone");
});

for (const role of ["supervisor", "foreman"] as const) {
  test(`${role} phone agenda shows today's work and keeps crew edits scoped`, async ({ page }) => {
    await useSupabaseFixtures(page, { role });
    const today = new Date().toLocaleDateString("en-CA");
    const row = (id: string, status: string, start_time: string, start_date = today, end_date = today) => ({
      id, status, start_time, start_date, end_date, project_id: "fixture-project", kind: "install",
      projects: { id: "fixture-project", job_code: id, name: "A long job name with travel and installation details for the whole crew" },
      schedule_assignment_members: [{ profile_id: "fixture-crew", role: "installer", profiles: { display_name: "Fixture crew member" } }],
    });
    await page.route("**/rest/v1/schedule_assignments**", r => json(r, new URL(r.request().url()).searchParams.get("status") === "eq.draft" ? [] : [
      row("LATE", "published", "13:00"), row("EARLY", "published", "07:00"),
      row("CANCELED", "canceled", "06:00"), row("OLD", "published", "05:00", "2020-01-01", "2020-01-02"),
    ], 4));
    await page.goto("/scheduling");
    const cards = page.locator(".sched-agenda-item");
    await expect(cards).toHaveCount(2);
    await expect(page.locator(".sched-conflict-banner")).not.toContainText("CANCELED");
    await expect(cards.first()).toContainText("EARLY");
    await expect(cards.last()).toContainText("LATE");
    await expect(cards.first()).toContainText("Fixture crew member");
    await expect(page.getByRole("button", { name: /Plan work on/ })).toHaveCount(role === "supervisor" ? 1 : 0);
    if (role === "foreman") {
      await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Fix", exact: true })).toHaveCount(0);
      await expect(page.locator(".sched-publishbar")).toHaveCount(0);
      await page.getByRole("tab", { name: "Week", exact: true }).click();
      await expect(page.getByRole("button", { name: /Add crew on/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "+ crew", exact: true })).toHaveCount(0);
      await page.getByRole("tab", { name: "Agenda", exact: true }).click();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const card of await cards.all()) expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `e2e/test-results/agenda-${role}-390.png`, fullPage: true,
      style: ".pwa-banner-wrong-project { visibility: hidden !important; }" });
  });
}

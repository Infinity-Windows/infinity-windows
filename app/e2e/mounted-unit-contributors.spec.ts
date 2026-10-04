import { expect, test, type Page } from "@playwright/test";
import { chooseWorkUnit, setupDataContributors, setupWorkContributors } from "./support/unitContributorsFixture";
import { DATA_OTHER, DATA_PROJECT, DATA_UNIT } from "./support/dataTotalsFixture";

const panel = (page: Page) => page.getByRole("region", { name: "Who worked on this unit" });
const check = (page: Page) => panel(page).getByRole("button", { name: "Check current records" });

test("mounted Work keeps names private until manual check and shows exact 3/2/1 labor shares", async ({ page }) => {
  const server = await setupWorkContributors(page);
  expect(server.reads).toBe(0);
  await expect(panel(page)).toHaveCount(0);
  await chooseWorkUnit(page);
  await expect(panel(page)).toContainText("Check current records to see this unit's labor.");
  expect(server.reads).toBe(0);
  await page.waitForTimeout(1100);
  expect(server.reads).toBe(0);
  await check(page).click();
  await expect(panel(page)).toContainText("6:00:00");
  await expect(panel(page)).toContainText("50.00% Share of unit labor");
  await expect(panel(page)).toContainText("33.33% Share of unit labor");
  await expect(panel(page)).toContainText("16.67% Share of unit labor");
  await expect(panel(page).locator("details.unit-contrib-person")).toHaveCount(3);
  await panel(page).locator("details.unit-contrib-person").first().locator("summary").click();
  await expect(panel(page)).toContainText("Activity detail");
  expect(server.requests).toEqual([{ p_project_id: "00000000-0000-4000-8000-000000000301",
    p_unit_id: "00000000-0000-4000-8000-000000000309", p_protocol_version: 1 }]);
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});

test("native phone layouts remain readable in English and Spanish without durable names", async ({ page }) => {
  const server = await setupWorkContributors(page); await chooseWorkUnit(page);
  server.mode = 36;
  await check(page).click();
  await expect(panel(page)).toContainText("Machine time is included in the activity above");
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.getByRole("button", { name: "EN/ES", exact: true }).click();
  const spanish = page.getByRole("region", { name: "Quién trabajó en esta unidad" });
  await expect(spanish).toContainText("El tiempo de máquina está incluido");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  const stores = await page.evaluate(() => {
    const fixture = window.mountedReviewFixture;
    return JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage },
      query: fixture.qc.getQueryCache().getAll().map(row => row.state.data) });
  });
  expect(stores).not.toContain("Same name");
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});

test("partial named work cannot acquire a made-up percentage", async ({ page }) => {
  const server = await setupWorkContributors(page); await chooseWorkUnit(page);
  server.mode = 35;
  await check(page).click();
  await expect(panel(page)).toContainText("Partial recorded total");
  await expect(panel(page)).toContainText("Share unavailable");
  await expect(panel(page)).toContainText("Named work has no proven matching timer duration.");
  await expect(panel(page)).not.toContainText("50.00% Share of unit labor");
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});

test("mounted names close on source changes, navigation, and return without an automatic retry", async ({ page }) => {
  const server = await setupWorkContributors(page); await chooseWorkUnit(page);
  await check(page).click(); await expect(panel(page)).toContainText("Same name");
  const firstCount = server.reads;
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(panel(page)).not.toContainText("Same name");
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.waitForTimeout(1000); expect(server.reads).toBe(firstCount);
  await check(page).click(); await expect(panel(page)).toContainText("Same name");
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole("tab", { name: "Specific", exact: true }).click();
  await expect(panel(page)).not.toContainText("Same name");
  expect(server.reads).toBe(firstCount + 1);
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});

test("pending name reply cannot reopen after a unit selection ABA", async ({ page }) => {
  const server = await setupWorkContributors(page); await chooseWorkUnit(page);
  server.hold = true; await check(page).click(); await expect.poll(() => server.pending.length).toBe(1);
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.getByRole("tab", { name: "Specific", exact: true }).click();
  server.hold = false; server.pending.splice(0).forEach(release => release());
  await expect(panel(page)).not.toContainText("Same name");
  expect(server.reads).toBe(1);
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});

for (const role of ["installer", "foreman", "partner"] as const) test(`mounted ${role} role cannot read contributor names`, async ({ page }) => {
  const server = await setupWorkContributors(page, role);
  await page.getByRole("tab", { name: "Specific", exact: true }).click();
  await page.getByRole("combobox", { name: "Choose a unit" }).selectOption("00000000-0000-4000-8000-000000000309");
  await expect(panel(page)).toHaveCount(0);
  expect(server.reads).toBe(0);
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});

test("native Data reads contributors on a selected unit even when older totals are unavailable", async ({ page }) => {
  const server = await setupDataContributors(page);
  server.data.mode = "unavailable";
  const totals = page.getByRole("region", { name: "Recorded timer totals" });
  await totals.getByRole("button", { name: "Specific", exact: true }).click();
  await totals.getByRole("combobox", { name: "Choose a unit", exact: true }).selectOption(DATA_UNIT);
  await expect(panel(page)).toContainText("Check current records to see this unit's labor.");
  expect(server.reads).toBe(0);
  await check(page).click();
  await expect(panel(page)).toContainText("6:00:00");
  expect(server.reads).toBe(1);
  expect(server.requests).toEqual([{ p_project_id: DATA_PROJECT, p_unit_id: DATA_UNIT, p_protocol_version: 1 }]);
  expect(server.data.unexpected).toEqual([]); expect(server.data.pageErrors).toEqual([]);
});

test("native Data selection and focus clear names; phone layout fits with keyboard input", async ({ page }) => {
  const server = await setupDataContributors(page);
  const totals = page.getByRole("region", { name: "Recorded timer totals" });
  await totals.getByRole("button", { name: "Specific", exact: true }).click();
  await totals.getByRole("combobox", { name: "Choose a unit", exact: true }).selectOption(DATA_UNIT);
  expect(server.reads).toBe(0);
  await check(page).click(); await expect(panel(page)).toContainText("Same name");
  await page.getByLabel("Start date", { exact: true }).focus();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(panel(page)).not.toContainText("Same name");
  const reads = server.reads;
  await page.waitForTimeout(1100); expect(server.reads).toBe(reads);
  await page.getByRole("combobox", { name: "Job", exact: true }).selectOption(DATA_OTHER);
  await expect(panel(page)).toHaveCount(0);
  expect(server.reads).toBe(reads);
  expect(server.data.unexpected).toEqual([]); expect(server.data.pageErrors).toEqual([]);
});


test("Work's one manual Check refreshes a stale profile with the real review sibling mounted", async ({ page }) => {
  const server = await setupWorkContributors(page); await chooseWorkUnit(page);
  await page.evaluate(() => {
    const qc = window.mountedReviewFixture.qc;
    qc.setQueryData(["myRealProfile"], qc.getQueryData(["myRealProfile"]), { updatedAt: Date.now() - 31000 });
  });
  await check(page).click(); await expect(panel(page)).toContainText("6:00:00");
  expect(server.reads).toBe(1);
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});

test("native keyboard opens the person detail and zero-duration audit stays outside worked people", async ({ page }) => {
  const server = await setupWorkContributors(page); await chooseWorkUnit(page); server.mode = 34;
  await check(page).click(); await expect(panel(page)).toContainText("Zero-duration timer records");
  await expect(panel(page)).toContainText("These entries are not counted as worked people or hours");
  await expect(panel(page).locator(".unit-contrib-person-list details")).toHaveCount(2);
  const person = panel(page).locator(".unit-contrib-person-list details").first();
  await check(page).focus(); await page.keyboard.press("Tab");
  await expect(person.locator("summary")).toBeFocused();
  await page.keyboard.press("Enter"); await expect(person).toHaveAttribute("open", "");
  await page.keyboard.press("Space"); await expect(person).not.toHaveAttribute("open", "");
  expect(server.reads).toBe(1);
  expect(server.unexpected).toEqual([]); expect(server.pageErrors).toEqual([]);
});

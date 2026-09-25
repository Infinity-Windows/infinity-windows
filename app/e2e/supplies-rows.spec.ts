// Supplies on a phone: the item's name gets the width, the buttons go under it.
//
// Crew report, 2026-09-06 (Android): the Supplies list showed each item's text
// one letter per line. A shelf row is a wrapping flex row: the name and its home
// spot on the left, Take / Count / Home / History on the right. The text side
// was `flex: 1`, a zero basis, and wrapping is decided on the basis, so the
// browser saw a text side that needed no room, kept all four buttons beside it
// at full width, and gave the name the sliver left over.
//
// The same screen opens from a job's "Supplies for this job" button
// (/supplies?job=<id>), which adds that job's request list below the shelf, so
// that door is checked too. A desktop has room for text and buttons side by
// side and must keep one line per supply.
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
const CONEX = "00000000-0000-4000-8000-00000000c0a1";

const SUPPLIES = [
  {
    id: "00000000-0000-4000-8000-0000000005b1",
    name: "OSI Quad Max sealant, almond",
    unit: "tube",
    home_container_id: CONEX,
    home_note: "top shelf, left of the door",
    on_hand: 140,
    last_counted_at: "2026-08-03T15:00:00Z",
  },
  {
    id: "00000000-0000-4000-8000-0000000005b2",
    name: "Backer rod, 3/8 in closed cell",
    unit: "roll",
    home_container_id: null,
    home_note: null,
    on_hand: null,
    last_counted_at: null,
  },
  {
    id: "00000000-0000-4000-8000-0000000005b3",
    name: "Composite shims, 8 in bundle",
    unit: "bundle",
    home_container_id: CONEX,
    home_note: null,
    on_hand: 12,
    last_counted_at: "2026-09-01T15:00:00Z",
  },
];

const ORDERS = [
  {
    id: "00000000-0000-4000-8000-0000000006c1",
    project_id: BLACK22.projectId,
    name: null,
    qty: 24,
    status: "needed",
    supplies: { name: SUPPLIES[0].name, unit: "tube" },
  },
];

async function useSupplyFixtures(page: Page) {
  await page.route("**/rest/v1/supplies**", (r) => json(r, SUPPLIES, SUPPLIES.length));
  await page.route("**/rest/v1/storage_containers**", (r) =>
    json(
      r,
      [{ id: CONEX, serial: "CTR-000007", name: "Conex 7", active: true, kind: "conex" }],
      1,
    ),
  );
  await page.route("**/rest/v1/supply_orders**", (r) => json(r, ORDERS, ORDERS.length));
}

/** The shelf rows: one per supply, each with the name in bold and four buttons. */
function shelfRows(page: Page): Locator {
  return page.locator("li.find-row").filter({ has: page.locator("button") });
}

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b, "element should be on screen").not.toBeNull();
  return b!;
}

/** A picture for checking by eye, taken BEFORE the assertions so a failing run
 *  still shows what the crew saw. Lands in e2e/test-results/, never committed. */
async function shoot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "the page should not scroll sideways").toBeLessThanOrEqual(0);
}

test.describe("on a 360 px Android phone", () => {
  test.use({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 });

  for (const language of ["en", "es"] as const) {
    test(`each supply's name gets the row and its buttons wrap under it (${language})`, async ({
      page,
    }, testInfo) => {
      await useSupabaseFixtures(page, { role: "installer", language });
      await useSupplyFixtures(page);
      await page.goto("/supplies");

      const rows = shelfRows(page);
      await expect(rows).toHaveCount(SUPPLIES.length);
      await shoot(page, testInfo, `supplies-360-${language}`);
      // The shelf lists running-low first; the order is not what this is about.
      expect((await rows.locator("strong").allInnerTexts()).sort()).toEqual(
        SUPPLIES.map((s) => s.name).sort(),
      );
      for (const row of await rows.all()) {
        const label = await row.locator("strong").innerText();
        const name = await box(row.locator("strong"));
        const take = await box(row.getByRole("button").first());
        expect(name.width, `"${label}" should not be squeezed`).toBeGreaterThan(120);
        // Under the text, not beside it.
        const textBox = await box(row.locator("> div").first());
        expect(take.y, `"${label}" buttons`).toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);
      }
      await noSidewaysScroll(page);
    });
  }

  test("the same rows hold when a job's Supplies button opens the page", async ({
    page,
  }, testInfo) => {
    await useSupabaseFixtures(page, { role: "installer" });
    await useSupplyFixtures(page);
    await page.goto(`/supplies?job=${BLACK22.projectId}`);

    // The job's request list is below the shelf on this door.
    const requested = page.locator("ul.work-list li.find-row");
    await expect(requested).toHaveCount(ORDERS.length);
    await shoot(page, testInfo, "supplies-360-job");
    const reqName = await box(requested.locator("strong"));
    expect(reqName.width).toBeGreaterThan(120);
    const status = await box(requested.locator("select"));
    const reqRow = await box(requested);
    expect(status.x + status.width).toBeLessThanOrEqual(reqRow.x + reqRow.width);

    const rows = shelfRows(page);
    await expect(rows).toHaveCount(SUPPLIES.length);
    for (const row of await rows.all()) {
      expect((await box(row.locator("strong"))).width).toBeGreaterThan(120);
    }
    await noSidewaysScroll(page);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test("each supply keeps its name and its buttons on one line", async ({ page }, testInfo) => {
    await useSupabaseFixtures(page, { role: "installer" });
    await useSupplyFixtures(page);
    await page.goto("/supplies");

    const rows = shelfRows(page);
    await expect(rows).toHaveCount(SUPPLIES.length);
    await shoot(page, testInfo, "supplies-desktop");
    for (const row of await rows.all()) {
      const name = await box(row.locator("strong"));
      const buttons = row.getByRole("button");
      await expect(buttons).toHaveCount(4);
      const take = await box(buttons.first());
      const history = await box(buttons.last());
      expect(name.width).toBeGreaterThan(120);
      // Beside the text: the buttons start to its right and share its line.
      expect(take.x).toBeGreaterThan(name.x + name.width);
      expect(take.y).toBeLessThan(name.y + name.height);
      expect(history.y).toBe(take.y);
    }
    await noSidewaysScroll(page);
  });
});

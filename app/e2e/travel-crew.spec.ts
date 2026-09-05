// The "Assigned crew" picker on the new-trip form lines up, whatever anybody
// is called.
//
// The bug this exists to stop coming back: nothing in the travel CSS sized the
// chip's checkbox, so it took the app's global `input, select` rule — the one
// written for the big office fields: `width: 100%`, `min-height: 52px`,
// `padding: 14px 15px`, `margin-bottom: 10px`. A checkbox is an input, so every
// chip carried a 52px-tall box whose WIDTH was whatever the flex row had left
// over after the name. A one-word name left 13px of it; "Tyson antonio diaz"
// left 71px — a grey square the size of a stamp, sitting beside the name. Chips
// came out 84px to 168px wide and 79px tall, in a wrapping flex row, so no two
// rows and no two columns agreed on anything.
//
// So the check is a measurement, not a look. Every chip must be exactly as tall
// as every other chip and exactly as wide, the columns must share a left edge
// on a phone and on a laptop, and the real checkbox must be OUT of the layout
// while still being the thing that gets checked. The roster below is shaped
// like the owner's own screenshot on purpose: one-word names, two-word names,
// and the three-word name that made the biggest square.
//
// It also drops a picture per width into e2e/__screenshots__/travel-crew for a
// human to eyeball. Those are throwaway, like every other screenshot this suite
// writes — see __screenshots__/README.md.

import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/travel-crew");

/** How many columns the grid should make at each width. 150px minimum plus an
 *  8px gap inside a sheet that is the phone's full width, then 560px capped. */
const COLUMNS: Record<number, number> = { 390: 2, 1024: 3 };

// Deliberately NOT in alphabetical order here: the picker is supposed to sort
// them, and a list that arrives sorted could not tell us whether it did.
const ROSTER: readonly (readonly [string, string, string])[] = [
  ["11111111-1111-4111-8111-111111111111", "Isaac", "supervisor"],
  ["22222222-2222-4222-8222-222222222222", "Chris", "installer"],
  ["33333333-3333-4333-8333-333333333333", "Antonio miguel", "installer"],
  ["44444444-4444-4444-8444-444444444444", "Chace cheek", "installer"],
  ["55555555-5555-4555-8555-555555555555", "Tyson antonio diaz", "installer"],
  ["66666666-6666-4666-8666-666666666666", "Maria", "installer"],
  ["77777777-7777-4777-8777-777777777777", "Dave", "foreman"],
] as const;

function profileRow(id: string, display_name: string, role: string) {
  return {
    id,
    display_name,
    role,
    skill_level: 3,
    active: true,
    language: "en",
    can_see_costs: false,
    can_see_pay: false,
    retired_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** Registered AFTER useSupabaseFixtures so these win — Playwright favours the
 *  most recently added route. */
async function useCrewFixtures(page: Page) {
  const all = [
    ...ROSTER.map(([id, name, role]) => profileRow(id, name, role)),
    // The signed-in supervisor: "New trip" is a supervisor+ button.
    profileRow(TEST_USER.id, "E2E Fixture", "supervisor"),
  ];
  await page.route("**/rest/v1/profiles**", (r) => {
    const url = new URL(r.request().url());
    const raw = url.searchParams.get("id");
    const id = raw?.startsWith("eq.") ? raw.slice(3) : raw;
    const rows = id ? all.filter((p) => p.id === id) : all;
    const single = (r.request().headers()["accept"] ?? "").includes("pgrst.object");
    return single ? json(r, rows[0] ?? null, rows.length ? 1 : 0) : json(r, rows, rows.length);
  });
  // No trips yet, so the page lands on its empty state and the only thing on
  // screen is the button this test needs.
  await page.route("**/rest/v1/trips**", (r) => json(r, [], 0));
}

interface ChipBox {
  width: number;
  height: number;
  left: number;
  /** The real checkbox's rendered height — the number the bug was made of. */
  inputHeight: number;
  /** The drawn tick box that replaced it. */
  boxSize: [number, number];
}

async function chipBoxes(page: Page): Promise<ChipBox[]> {
  return page.locator("[data-testid='travel-crew-chip']").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const input = el.querySelector("input[type=checkbox]")!.getBoundingClientRect();
      const box = el.querySelector(".travel-check")!.getBoundingClientRect();
      return {
        width: Math.round(r.width),
        height: Math.round(r.height),
        left: Math.round(r.left),
        inputHeight: Math.round(input.height),
        boxSize: [Math.round(box.width), Math.round(box.height)] as [number, number],
      };
    }),
  );
}

/** Opens Travel, taps "New trip", and scrolls the picker into the sheet. */
async function openPicker(page: Page) {
  await page.goto("/travel");
  await page.getByRole("button", { name: /New trip/i }).click();
  await expect(page.locator("[data-testid='travel-crew-picker']")).toBeVisible();
  await page.locator("[data-testid='travel-crew-picker']").scrollIntoViewIfNeeded();
}

for (const width of [390, 1024] as const) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });

    test(`every crew chip is the same box, in lined-up columns (${width}px)`, async ({
      page,
    }) => {
      await useSupabaseFixtures(page, { role: "supervisor" });
      await useCrewFixtures(page);
      await openPicker(page);

      const chips = page.locator("[data-testid='travel-crew-chip']");
      await expect(chips).toHaveCount(ROSTER.length + 1);

      // Taken before the assertions on purpose, so a failing run still leaves
      // the picture that explains it.
      mkdirSync(SHOTS, { recursive: true });
      await page.locator(".travel-sheet").screenshot({ path: join(SHOTS, `${width}.png`) });

      const boxes = await chipBoxes(page);

      // THE POINT: one height and one width for every chip, whether the name is
      // "Dave" or "Tyson antonio diaz".
      expect(new Set(boxes.map((b) => b.height)).size).toBe(1);
      expect(new Set(boxes.map((b) => b.width)).size).toBe(1);
      expect(boxes[0].height).toBe(48);

      // AND THE COLUMNS LINE UP: exactly as many distinct left edges as there
      // are columns, so every chip in a column starts on the same pixel — two
      // clean columns on a phone, three on a laptop.
      expect(new Set(boxes.map((b) => b.left)).size).toBe(COLUMNS[width]);

      // The thing that actually broke, named directly: the real checkbox is out
      // of the layout, so it can never grow into the chip again. 52 is the
      // global `input, select` min-height it used to take.
      for (const b of boxes) {
        expect(b.inputHeight).toBeLessThanOrEqual(2);
        expect(b.boxSize).toEqual([18, 18]);
      }

      // Sorted by name, because a grid of plain names with no rank on them is
      // read alphabetically — not in the role order listProfiles() returns.
      const names = await chips.evaluateAll((els) =>
        els.map((el) => (el.querySelector(".travel-crew-name") as HTMLElement).title),
      );
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
  });
}

test.describe("picking somebody", () => {
  test.use({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2 });

  test("tapping a chip turns it on, tapping it again turns it off", async ({ page }) => {
    await useSupabaseFixtures(page, { role: "supervisor" });
    await useCrewFixtures(page);
    await openPicker(page);

    const label = page.locator("[data-testid='travel-crew-label']");
    const chip = page.locator("[data-testid='travel-crew-chip']", { hasText: "Tyson" });
    const heightBefore = (await chipBoxes(page))[0].height;

    await expect(label).toHaveText("Assigned crew");
    await expect(chip).not.toHaveClass(/is-on/);

    await chip.click();
    await expect(chip).toHaveClass(/is-on/);
    await expect(chip.locator("input[type=checkbox]")).toBeChecked();
    // The count is what somebody who has scrolled past the grid reads.
    await expect(label).toHaveText("Assigned crew · 1 selected");

    await chip.click();
    await expect(chip).not.toHaveClass(/is-on/);
    await expect(chip.locator("input[type=checkbox]")).not.toBeChecked();
    await expect(label).toHaveText("Assigned crew");

    // Turning a chip on must not resize it, or the grid would shuffle under a
    // thumb halfway down the list.
    expect((await chipBoxes(page))[0].height).toBe(heightBefore);

    // Hidden, but still the control: it takes focus, so the picker is still
    // usable from a keyboard.
    await chip.locator("input[type=checkbox]").focus();
    await expect(chip.locator("input[type=checkbox]")).toBeFocused();
  });
});

// Maps Interactive assign mode (owner, 2026-08-14): a foreman picks
// windows ON the 3D model, picks one installer, and real sequenced
// assignments land through the same RPCs the Dispatch tab uses.
import { test, expect } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/** A tiny authored fitview model: one 18×6 m mass, two windows on the
 * south elevation carrying REAL fixture mark codes so the host can map
 * them to opening UUIDs. */
const MODEL = {
  building: {
    width: 18,
    depth: 6,
    height: 3,
    rise: 0,
    footprints: [
      [
        { x: 0, z: 0 },
        { x: 18, z: 0 },
        { x: 18, z: 6 },
        { x: 0, z: 6 },
      ],
    ],
  },
  windows: [
    { id: "10", elev: "s0", x: 3, y: 0.9, w: 1500, h: 1200 },
    { id: "11", elev: "s0", x: 8, y: 0.9, w: 1500, h: 1200 },
  ],
};

/** The one authored outline the map reads its model out of. */
async function useOutline(page: import("@playwright/test").Page) {
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: "00000000-0000-4000-8000-0000000a5519",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model: MODEL } },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]),
    }),
  );
}

test("the Assign button survives a profile that lands after the map", async ({
  page,
}) => {
  // The renderer reads `onAssign` ONCE, at mount, and unhides the Assign
  // button then or never. So the button depended on the supervisor's own
  // profile arriving before the job did — a race that used to be won by
  // accident and is lost by any slow connection. Whoever loses it gets a map
  // with no way to assign anything, and no error to explain it, until they
  // leave the tab and come back.
  //
  // Here the profile read is deliberately held back so the map is built for a
  // role that is not yet known. The button still has to show up.
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page);
  await page.route(/\/rest\/v1\/profiles\?.*id=eq\./, async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.fallback();
  });

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#assignBtn")).toBeVisible({ timeout: 30_000 });
});

test("map assign: pick windows, pick a person, sequenced RPCs fire", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page);

  const assigns: { opening: string; profile: string; sequence: number }[] = [];
  await page.route("**/rest/v1/rpc/assign_opening_to_installer", async (route) => {
    const body = route.request().postDataJSON() as {
      p_opening_id: string;
      p_profile_id: string;
      p_sequence: number;
    };
    assigns.push({
      opening: body.p_opening_id,
      profile: body.p_profile_id,
      sequence: body.p_sequence,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  // The 3D model is up once window buttons exist.
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  // Enter assign mode (foreman+ only sees this) and tap both windows.
  // The stage resolves taps from pointerdown's target (CSS-3D transforms
  // defeat coordinate hit-testing), so dispatch the pointer pair straight
  // on each button — same path a finger takes.
  await page.locator("#assignBtn").click();
  for (const id of ["10", "11"]) {
    await page.evaluate((winId) => {
      const el = document.querySelector(`button.win[data-id="${winId}"]`)!;
      const opts = { bubbles: true, pointerId: 7, clientX: 300, clientY: 300 };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    }, id);
  }
  await expect(page.locator("#assignCount")).toHaveText("2 picked");

  await page.locator("#assignGo").click();
  // One installer per opening: the crew chips act as a radio group.
  const chips = page.locator("#crew .chk");
  await expect(chips.first()).toBeVisible();
  await chips.first().click();
  const profileId = await chips.first().getAttribute("data-id");
  await page.locator("#assignApply").click();

  await expect
    .poll(() => assigns.length, { timeout: 15_000 })
    .toBe(2);
  // Sequenced 1..N (no existing work for this installer in fixtures), all
  // to the ONE picked person, mapped to the real fixture opening ids.
  expect(assigns.map((a) => a.sequence).sort()).toEqual([1, 2]);
  expect(new Set(assigns.map((a) => a.profile)).size).toBe(1);
  expect(assigns[0].profile).toBe(profileId);
  expect(new Set(assigns.map((a) => a.opening)).size).toBe(2);
});

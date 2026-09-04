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
  // The FLAT view (the default since 2026-08-19) is normal DOM — a real
  // click works; the old CSS-3D pointer gymnastics are only needed on the
  // 3D beta tab.
  await page.locator("#assignBtn").click();
  for (const id of ["10", "11"]) {
    await page.locator(`button.win[data-id="${id}"]`).first().click({ force: true });
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

test("the crew list arrives after the map and the assign sheet still lists it", async ({
  page,
}) => {
  // Found in the field 2026-09-04. The crew roster (listProfiles) was read
  // ONCE, when the scene was built, and handed to the vendored renderer as a
  // plain array. On a slow phone or a loaded machine that read lands AFTER the
  // model does — and nothing rebuilds the scene for it, because rebuilding
  // would throw the camera away. So the foreman taps "Assign…", gets "No crew
  // list on this device yet", and there is no way out of it but leaving the
  // tab and coming back.
  //
  // The role is NOT delayed here: getRealProfile keeps its own `id=eq.` read,
  // so the map is built once, for the right role, and never remounts. That is
  // the whole point — this is the race with no second chance.
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useOutline(page);

  let releaseCrew: () => void = () => {};
  const crewHeld = new Promise<void>((resolve) => {
    releaseCrew = resolve;
  });
  let crewServed = false;
  await page.route(
    (url) =>
      url.pathname.endsWith("/rest/v1/profiles") &&
      !(url.searchParams.get("id") ?? "").startsWith("eq."),
    async (route) => {
      await crewHeld;
      crewServed = true;
      await route.fallback();
    },
  );

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });
  // The race really happened: the model is on screen, the roster is not.
  expect(crewServed).toBe(false);

  // Somewhere to stand, so the fix can be checked against the thing it must
  // never cost: a unit selected, and a mark on the live host node.
  const unit = page.locator('button.win[data-id="11"]').first();
  await unit.click({ force: true });
  await expect(page.locator(".sheet .sh-id")).toHaveText("11");
  await page.locator("#stage").evaluate((el) => {
    (el as HTMLElement).dataset.cameraProbe = "kept";
  });

  releaseCrew();
  await expect.poll(() => crewServed, { timeout: 30_000 }).toBe(true);
  // Long enough for a rebuild to have happened, if one were going to.
  await page.waitForTimeout(500);

  // The camera survived: same host node, same selected unit, same open sheet.
  await expect(page.locator("#stage")).toHaveAttribute("data-camera-probe", "kept");
  await expect(unit).toHaveClass(/(^|\s)sel(\s|$)/);
  await expect(page.locator(".sheet .sh-id")).toHaveText("11");

  // And the sheet the foreman opens now names real people.
  await page.getByRole("button", { name: "Assign…" }).click();
  const chips = page.locator("#crew .chk");
  await expect(chips.first()).toBeVisible();
  expect(await chips.first().getAttribute("data-id")).toBeTruthy();
});

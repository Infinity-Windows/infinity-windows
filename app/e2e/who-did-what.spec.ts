// Wave Y — who did what (transcripts-program-spec).
//
// THE RULE THIS PROTECTS. An install used to be filed under whoever pressed
// Submit, which is right nearly every time and wrong the rest: a foreman
// finishing a unit for an installer whose phone died moved that window onto
// HIS record. Wave Y asks instead. Two halves have to hold together for that
// to be worth anything:
//
//   * the question is only asked when the unit is somebody else's, and the
//     ordinary finish keeps making the exact call it always made (so a phone
//     ahead of the migration still finishes units);
//   * the map's "Record install for…" reaches the REAL finish flow with the
//     person already chosen — it never marks anything done, and the after
//     photo and grade are still owed (owner-approved refusal).
//
// The map halves run on BLACK22's real openings and real mark codes, the same
// way map-assign.spec.ts does: the failure being guarded against is a shim
// callback that quietly renders nothing, and a synthetic square would not tell
// you that.

import { expect, test, type Page } from "@playwright/test";
import {
  jobFixtures,
  openingsFor,
  useSupabaseFixtures,
  TEST_USER,
} from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

type Json = Record<string, unknown>;
const REAL_OPENINGS = openingsFor(BLACK22.projectId) as unknown as Json[];

function str(v: unknown): string {
  return v as string;
}

/** Sam is a real fixture installer, so the picker is offering a real name. */
const SAM = "a59c174b-1d65-4f86-96cc-535c53e2213e";
const SAM_NAME = "Sam";

function opening(index: number, overrides: Json = {}): Json {
  return { ...REAL_OPENINGS[index], ...overrides };
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  };
}

/** Serve `getOpening` for these rows by id (same idiom as opening-sheet.spec). */
async function routeOpenings(page: Page, rows: Json[]) {
  const byId = new Map<string, Json>(rows.map((o) => [str(o.id), o]));
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      (url.searchParams.get("id") ?? "").startsWith("eq."),
    (route) => {
      const id = (
        new URL(route.request().url()).searchParams.get("id") ?? ""
      ).slice(3);
      const row = byId.get(id);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": row ? "0-0/1" : "*/0" },
        body: JSON.stringify(row ? [row] : []),
      });
    },
  );
}

/** Geolocation denied immediately, so the photo pipeline never waits one out. */
async function stubGeolocationDenied(page: Page) {
  await page.addInitScript(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, message: "denied" } as GeolocationPositionError);
    };
  });
}

/** Capture every finish_unit body the page sends. */
async function routeFinish(page: Page): Promise<Json[]> {
  const finishes: Json[] = [];
  await page.route("**/rest/v1/rpc/finish_unit", async (route) => {
    finishes.push(route.request().postDataJSON() as Json);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "evt-wave-y" }),
    });
  });
  return finishes;
}

test("Y2: finishing a unit on somebody else's list asks who installed it", async ({
  page,
}) => {
  // A foreman, because a foreman is who ends up filing for the crew — and the
  // role the picker opens the whole roster to.
  await useSupabaseFixtures(page, { role: "foreman" });
  await stubGeolocationDenied(page);
  const o = opening(1, {
    status: "assigned",
    needs_flashing: false,
    work_started_at: "2026-09-03T09:00:00Z",
    confirmed: true,
    assigned_to: SAM,
  });
  await routeOpenings(page, [o]);
  const finishes = await routeFinish(page);

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);
  await page.getByRole("button", { name: "3. Capture" }).click();

  // The question, and the assignee already chosen — the likeliest truth, and
  // the one that needs no tap at all.
  await expect(page.getByText("Who installed this?")).toBeVisible();
  const sam = page.locator(`[data-credit-id="${SAM}"]`);
  await expect(sam).toHaveAttribute("aria-pressed", "true");

  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles(pngFile("after.png"));
  await page.getByRole("button", { name: "4", exact: true }).click();
  await page.getByRole("button", { name: "Submit install" }).click();

  await expect.poll(() => finishes.length).toBe(1);
  expect(finishes[0]).toMatchObject({
    p_opening_id: str(o.id),
    p_quality_grade: 4,
    p_credited_to: SAM,
  });
});

test("Y2: finishing my own unit asks nobody and sends the call it always sent", async ({
  page,
}) => {
  // The half that matters most in the field. A phone running ahead of the
  // migration has no p_credited_to to send and no wider function to call, so
  // an ordinary finish must stay byte-for-byte the call it has always made.
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);
  const o = opening(2, {
    status: "assigned",
    needs_flashing: false,
    work_started_at: "2026-09-03T09:00:00Z",
    confirmed: true,
    assigned_to: TEST_USER.id,
  });
  await routeOpenings(page, [o]);
  const finishes = await routeFinish(page);

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);
  await page.getByRole("button", { name: "3. Capture" }).click();
  await expect(page.getByText("Who installed this?")).toHaveCount(0);

  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles(pngFile("after.png"));
  await page.getByRole("button", { name: "5", exact: true }).click();
  await page.getByRole("button", { name: "Submit install" }).click();

  await expect.poll(() => finishes.length).toBe(1);
  expect(Object.keys(finishes[0])).not.toContain("p_credited_to");
});

// ---------------------------------------------------------------------------
// The map halves — BLACK22's real openings, a real traced model
// ---------------------------------------------------------------------------

/** A small authored fitview model carrying REAL BLACK22 mark codes, so the
 * host can map a tapped window back to a real opening uuid. Same shape and
 * same reasoning as map-assign.spec.ts. */
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

async function useOutline(page: Page) {
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: "00000000-0000-4000-8000-0000000a5520",
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

/**
 * The real opening behind a mark code the model draws. An EXACT code match on
 * purpose: BLACK22 carries both "11" and "1-1", and anything that folds the
 * hyphen away picks whichever comes first in the file rather than the mark the
 * model actually drew (the app's own normalizeMarkCode only rewrites a
 * trailing letter, so "11" stays "11").
 */
function openingForMark(code: string): Json {
  const want = code.trim().toUpperCase();
  const match = REAL_OPENINGS.find(
    (o) => str(o.opening_code).trim().toUpperCase() === want,
  );
  expect(match, `BLACK22 has no opening for mark ${code}`).toBeTruthy();
  return match!;
}

test("Y3: Record install for… reaches the real finish flow with the person preset", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await stubGeolocationDenied(page);
  await useOutline(page);
  const unit = openingForMark("10");
  await routeOpenings(page, [
    {
      ...unit,
      status: "assigned",
      needs_flashing: false,
      work_started_at: "2026-09-03T09:00:00Z",
      confirmed: true,
      assigned_to: SAM,
    },
  ]);

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  await page.locator('button.win[data-id="10"]').first().click({ force: true });
  await page.getByRole("button", { name: "Record install for…" }).click();
  await page.locator(`[data-record-for="${SAM}"]`).click();

  // It lands on the WINDOW'S OWN SHEET with the person chosen — not on a
  // "marked done" toast. That is the owner-approved refusal, in a URL.
  await expect(page).toHaveURL(
    new RegExp(`/opening/${str(unit.id)}\\?credit=${SAM}$`),
  );

  await page.getByRole("button", { name: "3. Capture" }).click();
  await expect(page.locator(`[data-credit-id="${SAM}"]`)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // And the gate is still the gate: no after photo, no grade, no Submit.
  await expect(
    page.getByText("To submit, add an after photo and a quality grade."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit install" })).toBeDisabled();
});

test("Y4: Assign… on one unit opens the assign sheet with that unit picked", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useOutline(page);

  const assigns: Json[] = [];
  await page.route("**/rest/v1/rpc/assign_opening_to_installer", async (route) => {
    assigns.push(route.request().postDataJSON() as Json);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await page.goto(`/projects/${BLACK22.projectId}?tab=maps-interactive`);
  await expect(page.locator("button.win").first()).toBeVisible({ timeout: 60_000 });

  await page.locator('button.win[data-id="11"]').first().click({ force: true });
  await page.getByRole("button", { name: "Assign…" }).click();

  // ONE unit, without anybody entering pick mode for a single window.
  await expect(page.locator(".sheet .sh-id")).toHaveText("1 opening");
  const chips = page.locator("#crew .chk");
  await expect(chips.first()).toBeVisible();
  await chips.first().click();
  const profileId = await chips.first().getAttribute("data-id");
  await page.locator("#assignApply").click();

  await expect.poll(() => assigns.length, { timeout: 15_000 }).toBe(1);
  expect(assigns[0].p_profile_id).toBe(profileId);
  expect(assigns[0].p_opening_id).toBe(str(openingForMark("11").id));
  // The history row this writes says where the tap happened (Y5).
  expect(assigns[0].p_via).toBe("map");
});

test("Y5: the unit Record reads back who it was handed to", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const o = opening(3, { status: "installed", needs_flashing: false });
  await routeOpenings(page, [o]);

  // One filed round, so the Record card has a story to open at all.
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/install_events") &&
      (url.searchParams.get("project_opening_id") ?? "").startsWith("eq."),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/1" },
        body: JSON.stringify([
          {
            id: "evt-wave-y-record",
            created_at: "2026-09-03T17:10:00Z",
            started_at: "2026-09-03T16:00:00Z",
            installer: "E2E Fixture",
            installer_id: TEST_USER.id,
            credited_to: SAM,
            minutes: 42,
            quality_grade: 4,
            transcript_raw: null,
            photo_findings: null,
            voided_at: null,
            void_reason: null,
            voider: null,
          },
        ]),
      }),
  );
  await page.route("**/rest/v1/opening_assignment_events**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: "assign-wave-y-1",
          opening_id: str(o.id),
          project_id: str(o.project_id),
          from_profile: null,
          to_profile: SAM,
          changed_by: TEST_USER.id,
          changed_at: "2026-09-03T14:40:00Z",
          via: "dispatch",
        },
      ]),
    }),
  );

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);
  await page
    .getByRole("button", { name: /Record — everything saved on this window/ })
    .click();

  // The round names both people, so nobody has to guess which one did the work.
  await expect(
    page.getByText(`Installed by ${SAM_NAME} · filed by E2E Fixture`),
  ).toBeVisible();
  // And the hand-over sits in the timeline beside the sessions.
  await expect(
    page.getByText(`Assigned to ${SAM_NAME} by E2E Fixture`),
  ).toBeVisible();
});

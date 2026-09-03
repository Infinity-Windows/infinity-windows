// Job modes (standard-tracking-jobs slice 2): a TRACKING-only job is a lighter
// job. Its hub shows Overview, Plans & specs, the daily log, Photos, Chat and
// Time — and NOT the map, Maps Interactive, the Studio, dispatch or the brain —
// and pasting a URL for one of those hidden, data-only features lands back on the
// job's hub instead. A DATA job is unchanged. This drives the real page from a
// supervisor's `projects` fetch, one tracking job beside one data job.

import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const TRACKING_ID = "11111111-1111-4111-8111-111111111111";
const DATA_ID = "22222222-2222-4222-8222-222222222222";
const OPENING_ID = "33333333-3333-4333-8333-333333333333";

const PROJECTS = [
  {
    id: TRACKING_ID,
    job_code: "TRACK01",
    name: "Tracking Job",
    address: null,
    status: "active",
    is_test: false,
    allowed_modes: ["tracking"],
  },
  {
    id: DATA_ID,
    job_code: "DATA01",
    name: "Data Job",
    address: null,
    status: "active",
    is_test: false,
    allowed_modes: ["data"],
  },
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

// Registered AFTER useSupabaseFixtures so it wins (Playwright favours the most
// recently added route): our two jobs, carrying allowed_modes, in place of the
// captured fixture list.
async function useModeFixtures(page: Page) {
  await page.route("**/rest/v1/projects**", (r) => json(r, PROJECTS, PROJECTS.length));
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("a tracking job's hub shows the lighter tab set and hides the data-only tabs", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModeFixtures(page);
  await page.goto(`/projects/${TRACKING_ID}`);

  const tabs = page.locator(".hub-tabs");
  await expect(tabs.getByText("Overview", { exact: true })).toBeVisible();
  await expect(tabs.getByText("Plans & specs", { exact: true })).toBeVisible();
  await expect(tabs.getByText("Photos", { exact: true })).toBeVisible();
  await expect(tabs.getByText("Chat", { exact: true })).toBeVisible();
  await expect(tabs.getByText("Time", { exact: true })).toBeVisible();

  // The data-heavy tabs are gone.
  await expect(tabs.getByText("Maps Interactive", { exact: true })).toHaveCount(0);
  await expect(tabs.getByText("Dispatch", { exact: true })).toHaveCount(0);
  await expect(tabs.getByText("Brain", { exact: true })).toHaveCount(0);
  // No material staged → no Warehouse tab.
  await expect(tabs.getByText("Warehouse", { exact: true })).toHaveCount(0);
});

test("a tracking job wears its mode badge", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModeFixtures(page);
  await page.goto(`/projects/${TRACKING_ID}`);
  await expect(page.locator(".job-mode-badge").first()).toHaveText(/Tracking/i);
});

test("a URL for a hidden data-only feature lands back on the tracking job's hub", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModeFixtures(page);

  const bare = new RegExp(`/projects/${TRACKING_ID}(\\?.*)?$`);

  // ?tab=maps-interactive is stripped back to Overview.
  await page.goto(`/projects/${TRACKING_ID}?tab=maps-interactive`);
  await expect(page).toHaveURL(new RegExp(`/projects/${TRACKING_ID}$`));

  // The flash run, an opening sheet, and the Studio all redirect to the hub.
  await page.goto(`/projects/${TRACKING_ID}/flash-run`);
  await expect(page).toHaveURL(bare);

  await page.goto(`/projects/${TRACKING_ID}/opening/${OPENING_ID}`);
  await expect(page).toHaveURL(bare);

  await page.goto(`/studio/j/${TRACKING_ID}`);
  await expect(page).toHaveURL(bare);
});

test("a data job is unchanged — it keeps Maps Interactive and reaches its flash run", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModeFixtures(page);
  await page.goto(`/projects/${DATA_ID}`);

  const tabs = page.locator(".hub-tabs");
  await expect(tabs.getByText("Maps Interactive", { exact: true })).toBeVisible();
  await expect(tabs.getByText("Dispatch", { exact: true })).toBeVisible();
  await expect(tabs.getByText("Warehouse", { exact: true })).toBeVisible();

  // The flash run route is NOT redirected for a data job.
  await page.goto(`/projects/${DATA_ID}/flash-run`);
  await expect(page).toHaveURL(new RegExp(`/projects/${DATA_ID}/flash-run$`));
});

// ---------------------------------------------------------------------------
// Build this out (standard-tracking-jobs slice 6): the one-way upgrade from a
// tracking job to a full data job. The button is foreman+ and only on a tracking
// job; pressing it promotes the job and drops the foreman into the plan-set
// upload, and the job's data-heavy tabs switch on.
// ---------------------------------------------------------------------------

// A stateful projects route: the tracking job starts tracking-only and reads as
// data+tracking once the promote RPC has fired, so a refetch after "Build this
// out" sees the promoted job.
function usePromotableFixtures(page: Page): { wasPromoted: () => boolean } {
  const state = { promoted: false };
  void page.route("**/rest/v1/rpc/promote_project_to_data", (r) => {
    state.promoted = true;
    return json(
      r,
      { id: TRACKING_ID, job_code: "TRACK01", name: "Tracking Job", allowed_modes: ["data", "tracking"] },
      1,
    );
  });
  void page.route("**/rest/v1/projects**", (r) => {
    const track = { ...PROJECTS[0], allowed_modes: state.promoted ? ["data", "tracking"] : ["tracking"] };
    return json(r, [track, PROJECTS[1]], 2);
  });
  return { wasPromoted: () => state.promoted };
}

test("Build this out promotes a tracking job and reveals its data screens", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const promo = usePromotableFixtures(page);
  page.on("dialog", (d) => d.accept());

  await page.goto(`/projects/${TRACKING_ID}`);

  // The Build-this-out button lives on the tracking job's Overview.
  const buildOut = page.getByRole("button", { name: /Build this out/i });
  await expect(buildOut).toBeVisible();
  await buildOut.click();

  // It promotes the job (the RPC fired) and lands the foreman in the plan-set
  // upload — building it out is where the job starts getting built.
  await expect(page).toHaveURL(new RegExp(`/projects/${TRACKING_ID}/upload$`));
  expect(promo.wasPromoted()).toBe(true);

  // Back on the hub, the job now shows the data-heavy tabs it was hiding.
  await page.goto(`/projects/${TRACKING_ID}`);
  const tabs = page.locator(".hub-tabs");
  await expect(tabs.getByText("Maps Interactive", { exact: true })).toBeVisible();
  await expect(tabs.getByText("Dispatch", { exact: true })).toBeVisible();
  // And the flash run, once guarded, now renders instead of redirecting.
  await page.goto(`/projects/${TRACKING_ID}/flash-run`);
  await expect(page).toHaveURL(new RegExp(`/projects/${TRACKING_ID}/flash-run$`));
});

test("an installer never sees Build this out on a tracking job", async ({ page }) => {
  // Foreman+ only: an installer on the tracking job has no button.
  await useSupabaseFixtures(page, { role: "installer" });
  await useModeFixtures(page);
  await page.goto(`/projects/${TRACKING_ID}`);
  await expect(page.getByText("Overview", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Build this out/i })).toHaveCount(0);
});

test("a data job never offers Build this out — it is already built out", async ({
  page,
}) => {
  // Even a foreman, who WOULD see the button on a tracking job, sees none here.
  await useSupabaseFixtures(page, { role: "foreman" });
  await useModeFixtures(page);
  await page.goto(`/projects/${DATA_ID}`);
  await expect(page.getByText("Overview", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Build this out/i })).toHaveCount(0);
});

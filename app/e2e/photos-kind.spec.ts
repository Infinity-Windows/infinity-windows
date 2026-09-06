// Pick a job, then toggle Photos | Receipts — on the Photos page and on the
// job's own Photos tab, with the choice living in the URL so a reload comes
// back to it.
//
// Before this, ?kind=receipt was the ONLY way to a receipt list, which on a
// phone means there was no way: a foreman standing on a job could not see what
// the crew had bought for it. House style (receipts.spec.ts): mocked routes,
// real UI, and assert the URL a tap actually writes, because the URL is what
// survives a reload and what somebody pastes into the job chat.
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/photos");

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** A drawn stand-in for the stored image, so a screenshot shows a feed rather
 * than a grid of broken-image icons. The sign request answers with a path this
 * same handler then serves. */
const TILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">' +
  '<rect width="300" height="300" fill="#4a6b86"/>' +
  '<rect x="40" y="40" width="220" height="220" fill="none" stroke="#fff" stroke-width="10"/>' +
  '<line x1="150" y1="40" x2="150" y2="260" stroke="#fff" stroke-width="10"/></svg>';

async function usePhotoStorage(page: Page) {
  await page.route("**/storage/v1/**", (route) => {
    if (route.request().url().includes("/object/sign/")) {
      return json(route, { signedURL: "/object/authenticated/install-media/tile.png" });
    }
    if (route.request().method() !== "GET") {
      return json(route, { Key: "install-media/x.jpg" });
    }
    return route.fulfill({ status: 200, contentType: "image/svg+xml", body: TILE_SVG });
  });
}

function photoRow(i: number) {
  const at = new Date(Date.now() - i * 3_600_000).toISOString();
  return {
    id: `photo-${i}`,
    kind: "photo",
    storage_path: `install-media/${BLACK22.projectId}/feed/${i}.jpg`,
    created_by: "installer@example.com",
    created_at: at,
    project_id: BLACK22.projectId,
    lat: 30.2672,
    lng: -97.7431,
    accuracy_m: 8,
    taken_at: at,
    caption: null,
  };
}

function receiptRow(i: number, vendor: string, cents: number) {
  return {
    id: `receipt-${i}`,
    uploaded_by: "u1",
    project_id: BLACK22.projectId,
    pending_job_name: null,
    photo_path: `install-media/receipts/${i}.jpg`,
    amount_cents: cents,
    vendor,
    purchased_on: null,
    category: "materials",
    category_by: "ai",
    is_passthrough: true,
    note: null,
    ocr: null,
    created_at: new Date(Date.now() - i * 3_600_000).toISOString(),
    reviewed_by: null,
    reviewed_at: i === 1 ? new Date().toISOString() : null,
    cost_code_id: null,
    job_cost_id: null,
    projects: { job_code: "BLACK22", name: "Black Desert" },
    profiles: { display_name: "Test Installer" },
  };
}

/** Both halves of the feed have something in them, so the toggle is a real
 * switch between two lists rather than two empty states. */
async function useFeedRows(page: Page) {
  await page.route("**/rest/v1/attachments**", (r) =>
    json(r, [photoRow(1), photoRow(2), photoRow(3), photoRow(4)], 4),
  );
  await page.route("**/rest/v1/receipts**", (r) =>
    json(r, [receiptRow(1, "Home Depot", 4212), receiptRow(2, "Shell", 6890)], 2),
  );
}

/** The fixture env points at a made-up Supabase host, so the app's own
 * "Wrong database" banner covers the header in every screenshot. Same trick
 * stg-partner-wall.spec.ts uses, and for the same reason. */
async function hideWrongProjectBanner(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        const style = document.createElement("style");
        style.textContent = ".pwa-banner-wrong-project { display: none !important; }";
        document.head.appendChild(style);
      },
      { once: true },
    );
  });
}

const tab = (page: Page, name: "Photos" | "Receipts") =>
  page.getByRole("tab", { name, exact: true });

test("pick a job on the Photos page, then switch to that job's receipts", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await hideWrongProjectBanner(page);
  await useSupabaseFixtures(page, { role: "foreman" });
  await usePhotoStorage(page);
  await useFeedRows(page);

  await page.goto("/photos");
  // The job is picked the way a person picks it, from the page's own filter.
  await page.getByLabel("Filter by job").selectOption(BLACK22.projectId);
  await expect(page).toHaveURL(new RegExp(`project=${BLACK22.projectId}`));

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/photos-390-dark-after.png` });

  await tab(page, "Receipts").click();

  // BOTH parameters: the job survives the toggle. Losing it here would drop a
  // foreman from "BLACK22's receipts" to "everybody's receipts" without saying
  // so, which is the kind of quiet widening that money screens must not do.
  await expect(page).toHaveURL(new RegExp(`project=${BLACK22.projectId}`));
  await expect(page).toHaveURL(/kind=receipt/);

  // And it is really the receipts list: vendor and amount, from the receipts
  // table, not the photo grid.
  await expect(page.getByText("Home Depot")).toBeVisible();
  await expect(page.getByText("$42.12")).toBeVisible();
  await expect(page.getByRole("button", { name: /Add receipt/ })).toBeVisible();

  // Back to photos, and the job is still there.
  await tab(page, "Photos").click();
  await expect(page).toHaveURL(new RegExp(`project=${BLACK22.projectId}`));
  await expect(page).not.toHaveURL(/kind=receipt/);
  await expect(page.getByRole("button", { name: /Add photo/ })).toBeVisible();
});

test("the same toggle on the job's own Photos tab, and a reload comes back to it", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await hideWrongProjectBanner(page);
  await useSupabaseFixtures(page, { role: "foreman" });
  await usePhotoStorage(page);
  await useFeedRows(page);

  await page.goto(`/projects/${BLACK22.projectId}?tab=photos`);
  await expect(tab(page, "Receipts")).toBeVisible();
  await tab(page, "Receipts").click();

  // The tab has to survive alongside the kind, or the toggle would throw the
  // person back to the job's Overview.
  await expect(page).toHaveURL(/tab=photos/);
  await expect(page).toHaveURL(/kind=receipt/);
  await expect(page.getByText("Home Depot")).toBeVisible();

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/hub-390-light-after.png` });

  // A reload is the whole reason this lives in the URL: a phone that went to
  // sleep on the receipts list must not wake up on the photo grid.
  await page.reload();
  await expect(page.getByText("Home Depot")).toBeVisible();
  await expect(tab(page, "Receipts")).toHaveAttribute("aria-selected", "true");
});

test("the /photos?kind=receipt&capture=1 deep link still opens the receipt sheet", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await usePhotoStorage(page);
  await useFeedRows(page);

  // The Capture button's own door into this page. It predates the toggle and
  // has to keep working exactly as it did — the toggle just shows where it
  // landed you.
  await page.goto("/photos?kind=receipt&capture=1");
  await expect(page.getByRole("heading", { name: "Add a receipt" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(tab(page, "Receipts")).toHaveAttribute("aria-selected", "true");
});

test("an installer's empty receipts list says these are only their own", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await usePhotoStorage(page);
  await page.route("**/rest/v1/receipts**", (r) => json(r, [], 0));

  await page.goto(`/photos?project=${BLACK22.projectId}&kind=receipt`);

  // The receipts table's RLS hands an installer their OWN uploads and nothing
  // else, so an empty list here does not mean the job has no receipts. Saying
  // that out loud is the difference between "there are none" and "there are
  // none of yours".
  await expect(page.getByText("You only see receipts you added.")).toBeVisible();
});

test("a foreman's empty receipts list does not, because they see them all", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await usePhotoStorage(page);
  await page.route("**/rest/v1/receipts**", (r) => json(r, [], 0));

  await page.goto(`/photos?project=${BLACK22.projectId}&kind=receipt`);

  await expect(page.getByText("No receipts yet")).toBeVisible();
  await expect(page.getByText("You only see receipts you added.")).toHaveCount(0);
});

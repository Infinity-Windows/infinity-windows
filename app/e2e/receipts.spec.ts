// Wave P: ONE spec covering the snap flow (P3) and the office table's role
// gate (P4). Same house style as daily-logs.spec.ts / opening-sheet.spec.ts:
// mocked routes, real UI, assert the CAPTURED RPC PAYLOAD a tap actually
// sends, not just that something rendered.
import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

/** A tiny (1x1) real PNG — small enough to inline, real enough for the
 * capture pipeline's canvas decode (createImageBitmap/Image) to succeed.
 * Same fixture opening-sheet.spec.ts uses for the same reason. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
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

/** Every receipt photo "upload" (and its later sign request) succeeds,
 * whatever bucket/path it targets — the snap flow's own storage traffic,
 * not fixture data, so there is nothing to read from disk. Registered
 * AFTER useSupabaseFixtures so it wins (Playwright gives priority to the
 * most-recently-added route), same idiom every other spec here uses. */
async function useReceiptStorage(page: Page) {
  await page.route("**/storage/v1/object/**", (route) => {
    const url = route.request().url();
    if (url.includes("/object/sign/")) {
      return json(route, { signedURL: "/receipt-fixture.jpg" });
    }
    return json(route, { Key: "install-media/receipts/x.jpg" });
  });
}

test("an installer snaps a receipt: file_receipt fires, then the passthrough question fires update_receipt", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useReceiptStorage(page);

  const filed: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/file_receipt", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    filed.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: body.p_id, ...body }),
    });
  });
  const updated: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/update_receipt", async (route) => {
    updated.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });
  // receipt_answer's handler reads the row's OTHER fields fresh (see its own
  // comment: never race a fire-and-forget extraction) before resending them
  // through update_receipt — a freshly-filed, nothing-extracted-yet row.
  await page.route("**/rest/v1/receipts**", (route) =>
    json(route, {
      amount_cents: null,
      vendor: null,
      purchased_on: null,
      category: null,
      note: null,
    }),
  );

  // No job in the URL — the spec's "job field is OPTIONAL" (gas is often
  // jobless): file_receipt's very first call must carry no job at all.
  await page.goto("/photos?kind=receipt&capture=1");
  await expect(page.getByRole("heading", { name: "Add a receipt" })).toBeVisible();

  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles(pngFile("receipt.png"));

  await expect.poll(() => filed.length).toBe(1);
  expect(filed[0]).toMatchObject({
    p_project_id: null,
    p_pending_job_name: null,
    p_note: null,
  });
  expect(filed[0].p_photo_path).toMatch(/^install-media\/receipts\/.+\.jpg$/);
  // The offline outbox mints the id client-side (crypto.randomUUID()) and
  // the photo path is built from that same id — see receiptPhotoPath.
  expect(filed[0].p_photo_path).toContain(String(filed[0].p_id));

  // "Bill this to the customer?" — the upload flow's one question. Answering
  // it (and nothing else — the job is left unanswered, which is allowed:
  // "everything skippable, a bare photo is a valid receipt") fires exactly
  // one update_receipt carrying just that answer.
  await expect(page.getByText("Bill this to the customer?")).toBeVisible();
  await page.getByRole("button", { name: "Yes", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => updated.length).toBe(1);
  expect(updated[0]).toMatchObject({
    p_id: filed[0].p_id,
    p_project_id: null,
    p_pending_job_name: null,
    p_is_passthrough: true,
  });

  await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
});

test("an installer never sees the office receipts table — RLS blocks the read, this proves the UI honors it too", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });

  // A direct deep link must not render the office table — RequireRole gates
  // the ROUTE itself (nav.ts's canAccess, minRole: supervisor), the same
  // defense-in-depth pattern daily-logs.spec.ts proves for the Logs tab.
  // The real wall is receipts' own RLS (foreman+, or the uploader's own
  // rows) — this only proves the UI honors it too.
  await page.goto("/receipts");
  await expect(page.getByRole("heading", { name: "Receipts" })).toHaveCount(0);
  await expect(page.getByText("Not available for your role")).toBeVisible();
});

test("a supervisor reaches the office receipts table", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });

  await page.goto("/receipts");
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
  await expect(page.getByText("Not available for your role")).toHaveCount(0);
});

// A receipt that arrived as a PDF — the emailed fuel invoice, the supply-house
// statement (owner's ask, 2026-09-05: "it needs to be able to do pdf receipts
// as well").
//
// House style (receipts.spec.ts, global-capture.spec.ts): mocked routes, real
// UI, assert what the tap actually SENDS. Here that is three things in order —
// the rendered page one uploaded as a .jpg, `file_receipt` filed against it,
// and THEN the original .pdf uploaded and recorded by `set_receipt_document`.
// The order is the point: the second entry `dependsOn` the first, because
// set_receipt_document cannot name a receipt that has not been filed yet.
//
// The PDF is real bytes, not a stub. Everything interesting on the way through
// — pdf.js opening the file, counting its pages, rendering page one onto a
// canvas — happens in the browser, and a fake would test the mock instead.
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/pdf-receipts");

/**
 * The smallest thing that is genuinely a PDF: a catalog, a page tree, and N
 * blank pages of a fixed size, with a real xref. Built rather than committed as
 * a binary so the page count is a knob — the note a PDF receipt files ("PDF, 2
 * pages") is the only place the count is ever recorded.
 */
function tinyPdf(pageCount: number): Buffer {
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(" ");
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>`,
    ...Array.from({ length: pageCount }, () => "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>"),
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A tiny (1x1) real PNG, for the <img> that a signed thumbnail URL resolves
 * to — the fixture's own storage handler answers 404 (or worse) for anything
 * it cannot find on disk, and a broken thumbnail would sit in the screenshots. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pdfFile(name: string, pages = 2) {
  return { name, mimeType: "application/pdf", buffer: tinyPdf(pages) };
}

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

function servePng(route: Route) {
  return route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from(TINY_PNG_BASE64, "base64"),
  });
}

/** Sign every receipt thumbnail, and answer the signed URL with a real pixel.
 * As broad as the fixtures' own storage route so it wins for both halves.
 *
 * Returns the list of objects the page asked to sign, in order — which is the
 * only way to see WHICH object a tap on "Open original" actually reaches for. */
async function useReceiptThumbnails(page: Page): Promise<string[]> {
  const signed: string[] = [];
  await page.route("**/storage/v1/**", (route) => {
    const url = route.request().url();
    if (url.includes("/object/sign/")) {
      signed.push(decodeURIComponent(url.split("/object/sign/")[1].split("?")[0]));
      return json(route, { signedURL: "/receipt-fixture.png" });
    }
    return servePng(route);
  });
  return signed;
}

/** "Open original" opens a tab. The assertion is about which OBJECT gets
 * signed, not about the tab, and a real popup is one more page to chase. */
async function stubWindowOpen(page: Page) {
  await page.addInitScript(() => {
    window.open = () =>
      ({ opener: null, location: { href: "" }, close: () => {} }) as unknown as Window;
  });
}

/** The receipt sheet's library input: the one WITHOUT `capture` on it. */
const receiptFileInput = (page: Page) =>
  page.locator('.jobphoto-actions input[type="file"]:not([capture])');

/** Headless Chromium cannot answer the real permission prompt; make the
 * outcome deterministic. A PDF receipt asks for no fix anyway — that is the
 * point of the time-only stamp — but the sheet still warms one on mount. */
async function stubGeolocationDenied(page: Page) {
  await page.addInitScript(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, message: "denied" } as GeolocationPositionError);
    };
    navigator.geolocation.watchPosition = (_ok, err) => {
      err?.({ code: 1, message: "denied", PERMISSION_DENIED: 1 } as GeolocationPositionError);
      return 1;
    };
    navigator.geolocation.clearWatch = () => {};
  });
}

/** The fixture env points at a made-up Supabase host, so the app's own "Wrong
 * database" banner would cover the header in every screenshot. */
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

const DOC_PATH = "install-media/receipts/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.pdf";

/** One filed PDF receipt, as the office table and the feed read it back. */
function receiptRow() {
  return {
    id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    uploaded_by: "u1",
    project_id: null,
    pending_job_name: null,
    photo_path: "install-media/receipts/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg",
    amount_cents: 4210,
    vendor: "Shell",
    purchased_on: "2026-09-04",
    category: "gas",
    category_by: "ai",
    is_passthrough: null,
    note: "PDF, 2 pages",
    ocr: null,
    created_at: "2026-09-04T15:04:00Z",
    reviewed_by: null,
    reviewed_at: null,
    cost_code_id: null,
    job_cost_id: null,
    document_path: DOC_PATH,
    projects: null,
    profiles: { display_name: "Sam" },
  };
}

test("a PDF receipt files page one as its picture, then sends the original after it", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);
  await hideWrongProjectBanner(page);

  /** Everything the tap sends, in the order it went. */
  const events: string[] = [];
  const uploaded: string[] = [];
  const filed: Record<string, unknown>[] = [];
  const documented: Record<string, unknown>[] = [];

  // As BROAD as the fixtures' own storage route (**/storage/v1/**), or theirs
  // wins for anything outside /object/ — a signed URL resolves to
  // <supabase>/storage/v1/<name>, which /object/ does not cover.
  await page.route("**/storage/v1/**", (route) => {
    const url = route.request().url();
    if (url.includes("/object/sign/")) return json(route, { signedURL: "/receipt-fixture.jpg" });
    if (!url.includes("/object/")) return servePng(route);
    const path = url.split("/object/")[1]?.split("?")[0] ?? url;
    uploaded.push(decodeURIComponent(path));
    events.push(`upload:${decodeURIComponent(path).split(".").pop()}`);
    return json(route, { Key: path });
  });
  await page.route("**/rest/v1/rpc/file_receipt", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    filed.push(body);
    events.push("file_receipt");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: body.p_id, ...body }),
    });
  });
  await page.route("**/rest/v1/rpc/set_receipt_document", async (route) => {
    documented.push(route.request().postDataJSON() as Record<string, unknown>);
    events.push("set_receipt_document");
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });
  // The follow-up question's handler reads the row's other fields fresh.
  await page.route("**/rest/v1/receipts**", (route) =>
    json(route, { amount_cents: null, vendor: null, purchased_on: null, category: null, note: null }),
  );

  await page.goto("/photos?kind=receipt&capture=1");
  await expect(page.getByRole("heading", { name: "Add a receipt" })).toBeVisible();

  // THE CHANGE, in one assertion: the receipt picker takes a PDF. A photo
  // picker still does not — see photos-upload.spec.ts.
  await expect(receiptFileInput(page)).toHaveAttribute("accept", "image/*,application/pdf");

  await receiptFileInput(page).setInputFiles(pdfFile("shell-invoice.pdf", 2));

  await expect.poll(() => filed.length, { timeout: 60_000 }).toBe(1);

  // Page one, rendered on the phone, filed exactly where a snapped receipt's
  // photo goes — so extract-receipt, the feed thumbnail and the office table
  // all keep working with no change at all.
  expect(filed[0].p_photo_path).toMatch(/^install-media\/receipts\/.+\.jpg$/);
  expect(filed[0].p_photo_path).toContain(String(filed[0].p_id));
  // Page one is the automatic read; the note is where the rest of the pages
  // get mentioned, because the picture cannot say it.
  expect(filed[0].p_note).toBe("PDF, 2 pages");

  // And then the original, on its own entry, against the same receipt.
  await expect.poll(() => documented.length, { timeout: 60_000 }).toBe(1);
  expect(documented[0]).toEqual({
    p_id: filed[0].p_id,
    p_document_path: `install-media/receipts/${String(filed[0].p_id)}.pdf`,
  });
  expect(uploaded).toContain(`install-media/receipts/${String(filed[0].p_id)}.pdf`);

  // ORDER IS THE CONTRACT. `dependsOn` is what keeps set_receipt_document from
  // naming a receipt the server has never heard of — a race that would dead-
  // letter the original on every phone with a slow connection.
  expect(events.indexOf("set_receipt_document")).toBeGreaterThan(events.indexOf("file_receipt"));
  expect(events.indexOf("upload:pdf")).toBeGreaterThan(events.indexOf("file_receipt"));

  // The ordinary receipt flow carries on from here, unchanged.
  await expect(page.getByText("Bill this to the customer?")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/receipt-sheet-pdf-390-dark.png` });
});

test("a PDF that will not open says so by name, and files nothing", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);

  const filed: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/file_receipt", async (route) => {
    filed.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });
  await page.route("**/storage/v1/**", (route) => json(route, { Key: "x" }));

  await page.goto("/photos?kind=receipt&capture=1");
  await expect(page.getByRole("heading", { name: "Add a receipt" })).toBeVisible();

  // A truncated download: the name and the type say PDF, the bytes do not.
  await receiptFileInput(page).setInputFiles({
    name: "half-a-receipt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nthis got cut off"),
  });

  // Named, so a pick says WHICH file — and in words about what to do next.
  await expect(page.getByText("half-a-receipt.pdf")).toBeVisible();
  await expect(page.getByText(/password-protected or damaged/)).toBeVisible();

  // NOTHING filed: a receipt row pointing at a picture that was never made
  // would show the office a broken thumbnail with nothing behind it.
  expect(filed).toHaveLength(0);
  await expect(page.getByText("Bill this to the customer?")).toHaveCount(0);
});

test("the feed tags a PDF receipt and offers the original", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });

  await useReceiptThumbnails(page);
  await page.route("**/rest/v1/receipts**", (route) => json(route, [receiptRow()], 1));

  await page.goto("/photos?kind=receipt");
  await expect(page.getByText("Shell")).toBeVisible();

  // The tag IS the way back to the original — a 120px tile has the vendor and
  // the amount on it already, so the accessible name is the action.
  const original = page.getByRole("button", { name: "Open original" });
  await expect(original).toBeVisible();
  await expect(original).toHaveText(/PDF/);

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/feed-pdf-tag-390-light.png` });
});

test("the office table row says PDF and opens the original", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  await stubWindowOpen(page);
  await page.setViewportSize({ width: 1200, height: 900 });

  const signed = await useReceiptThumbnails(page);
  await page.route("**/rest/v1/receipts**", (route) => json(route, [receiptRow()], 1));

  await page.goto("/receipts");
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
  await expect(page.getByText(/Shell/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open original" })).toBeVisible();

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/office-row-pdf-1200.png` });

  // WHICH object the tap reaches for, which is the whole of the rule: the
  // bucket and the path are worked out from the receipt's own id, never read
  // out of the row. A row is something a phone wrote — signing the bucket it
  // names would let one hand out a link to any object the tapper can read.
  await page.getByRole("button", { name: "Open original" }).click();
  await expect
    .poll(() => signed.filter((o) => o.endsWith(".pdf")))
    .toEqual([`install-media/receipts/${receiptRow().id}.pdf`]);
});

test("a receipt row pointing somewhere else signs nothing at all", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await hideWrongProjectBanner(page);
  await stubWindowOpen(page);
  await page.setViewportSize({ width: 1200, height: 900 });

  const signed = await useReceiptThumbnails(page);
  // The shape the database now refuses to store (20260990000000) — asserted
  // here anyway, because a client that would sign it is a client one bad row
  // away from handing somebody an ID document named as a Shell invoice.
  await page.route("**/rest/v1/receipts**", (route) =>
    json(route, [{ ...receiptRow(), document_path: "credential-docs/u9/anything.pdf" }], 1),
  );

  await page.goto("/receipts");
  await expect(page.getByText(/Shell/)).toBeVisible();
  await page.getByRole("button", { name: "Open original" }).click();

  // The office is told, in words about signal rather than about buckets — and
  // storage is never asked for the object at all.
  await expect(page.getByText(/Couldn't open that PDF just now/)).toBeVisible();
  expect(signed.filter((o) => o.endsWith(".pdf"))).toEqual([]);
});

import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const DOC = `install-media/receipts/${ID}.pdf`;
const receipt = {
  id: ID, uploaded_by: "u1", project_id: null, pending_job_name: null,
  photo_path: `install-media/receipts/${ID}.jpg`, amount_cents: 4210,
  vendor: "Shell", purchased_on: "2026-09-04", category: "gas", category_by: "ai",
  is_passthrough: null, note: null, ocr: null, created_at: "2026-09-04T15:04:00Z",
  reviewed_by: null, reviewed_at: null, cost_code_id: null, job_cost_id: null,
  document_path: null, projects: null, profiles: { display_name: "Sam" },
};
const IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1600" viewBox="0 0 800 1600"><rect width="800" height="1600" fill="white"/><g font-family="monospace" fill="black" text-anchor="middle"><text x="400" y="150" font-size="64">SAMPLE RECEIPT</text><text x="400" y="280" font-size="40">Shell</text><text x="400" y="400" font-size="32">Sep 4, 2026</text><text x="400" y="700" font-size="40">Fuel: $42.10</text><text x="400" y="1100" font-size="28">Thank you</text><text x="400" y="1450" font-size="24">Test fixture only</text></g></svg>`;

async function useReceiptViewerFixtures(page: Page, office = false, pdf = false, missing = false, spanish = false) {
  // Fixture setup is an async browser helper, not a React hook.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  await useSupabaseFixtures(page, { role: office ? "supervisor" : "installer", language: spanish ? "es" : "en" });
  await hideWrongProjectBanner(page);
  const signed: string[] = [];
  await page.addInitScript(() => {
    window.open = () => ({ opener: null, location: { href: "" }, close: () => {} }) as unknown as Window;
  });
  await page.route("**/storage/v1/**", (route) => {
    const url = route.request().url();
    if (url.includes("/object/sign/")) {
      signed.push(decodeURIComponent(url.split("/object/sign/")[1].split("?")[0]));
      return missing ? route.fulfill({ status: 400, contentType: "application/json", body: '{"message":"Unavailable"}' }) : json(route, { signedURL: "/receipt-viewer.svg" });
    }
    return route.fulfill({ contentType: "image/svg+xml", body: IMAGE });
  });
  await page.route("**/rest/v1/receipts**", (route) => json(route, [{ ...receipt, document_path: pdf ? DOC : null }], 1));
  await page.goto(office ? "/receipts" : "/photos?kind=receipt");
  return signed;
}

for (const office of [false, true]) {
  for (const width of [390, 1200]) {
    test(`${office ? "office" : "folder"} opens and zooms a receipt at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await useReceiptViewerFixtures(page, office);
      const open = page.getByRole("button", { name: "View receipt: Shell" });
      await open.click();
      const dialog = page.getByRole("dialog", { name: "Receipt: Shell" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("img", { name: "Shell" })).toBeVisible();
      await expect.poll(() => dialog.getByRole("img", { name: "Shell" }).evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      if (!office && width === 390 && process.env.RECEIPT_SCREENSHOT_PATH) {
        await page.locator(".receipt-viewer-backdrop").evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
        await page.locator(".receipt-viewer-backdrop").evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  await page.screenshot({ path: process.env.RECEIPT_SCREENSHOT_PATH.replace("VIEWER-SPANISH", "VIEWER-PHONE") });
      }
      await expect(dialog).toContainText("$42.10");
      await expect(dialog.getByRole("button", { name: /Remove/ })).toHaveCount(0);
      const bounds = await dialog.boundingBox();
      expect(bounds!.width).toBeGreaterThan(width * 0.8);
      await dialog.getByRole("button", { name: "Zoom in" }).click();
      await expect(dialog.getByRole("button", { name: "Fit to screen" })).toHaveAttribute("aria-pressed", "true");
      const scroll = await dialog.locator(".receipt-viewer-image").evaluate((e) => ({ width: e.clientWidth, scrollWidth: e.scrollWidth, height: e.clientHeight, scrollHeight: e.scrollHeight }));
      expect(scroll.scrollWidth).toBeGreaterThan(scroll.width);
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.height);
      await dialog.getByRole("button", { name: "Fit to screen" }).click();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(open).toBeFocused();
      await open.press("Enter");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(open).toBeFocused();
    });
  }
}

test("PDF original stays separate from preview and opens the correct document", async ({ page }) => {
  const signed = await useReceiptViewerFixtures(page, false, true);
  await expect(page.locator("button button")).toHaveCount(0);
  await page.getByRole("button", { name: "Open original", exact: true }).click();
  await expect.poll(() => signed.filter((s) => s.endsWith(".pdf"))).toEqual([DOC]);
  await expect(page.getByRole("dialog", { name: "Receipt: Shell" })).toHaveCount(0);
  await page.getByRole("button", { name: "View receipt: Shell" }).click();
  const dialog = page.getByRole("dialog", { name: "Receipt: Shell" });
  await dialog.getByRole("button", { name: "Open original", exact: true }).click();
  await expect.poll(() => signed.filter((s) => s.endsWith(".pdf")).length).toBe(2);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Open original", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
});

test("unavailable receipt can be closed and does not enable zoom", async ({ page }) => {
  await useReceiptViewerFixtures(page, false, false, true);
  await page.getByRole("button", { name: "View receipt: Shell" }).click();
  const dialog = page.getByRole("dialog", { name: "Receipt: Shell" });
  await expect(dialog.getByText(/offline/i)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Zoom in" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("Spanish receipt viewer fits a short landscape phone", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await useReceiptViewerFixtures(page, false, true, false, true);
  await page.getByRole("button", { name: "Ver recibo: Shell" }).click();
  const dialog = page.getByRole("dialog", { name: "Recibo: Shell" });
  await expect(dialog.getByRole("button", { name: "Ampliar" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Abrir original" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cerrar", exact: true })).toBeInViewport();
  await page.locator(".receipt-viewer-backdrop").evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  await page.screenshot({ path: process.env.RECEIPT_SCREENSHOT_PATH ?? "e2e/test-results/receipt-viewer-spanish.png" });
  await page.locator(".receipt-viewer-backdrop").click({ position: { x: 1, y: 1 } });
  await expect(dialog).toHaveCount(0);
});

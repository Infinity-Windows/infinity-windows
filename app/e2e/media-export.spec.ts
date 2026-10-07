// Real export UI and real archive bytes, against a fixture-only Supabase.
// The export must read past the feed's first 60 rows, keep its job/date scope,
// and retain each original file even when receipt names collide.
import { expect, test, type Page, type Route, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, TINY_PNG_BASE64 } from "./support/specHelpers";

test.use({ timezoneId: "America/Denver" });

const JOB = jobFixtures().find(j => j.jobCode === "BLACK22")!;
const OTHER = jobFixtures().find(j => j.jobCode === "PECAN14")!;
const PNG = Buffer.from(TINY_PNG_BASE64, "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const ON_DAY = "2026-10-05T18:00:00Z";

type PhotoRow = { id: string; kind: string; storage_path: string; project_id: string | null; created_at: string; taken_at: string; created_by: string; deleted_at: null; caption: null; lat: null; lng: null; accuracy_m: null };
function photo(i: number, projectId = JOB.projectId, takenAt = ON_DAY): PhotoRow {
  return { id: `photo-${String(i).padStart(3, "0")}`, kind: "photo", storage_path: `install-media/${projectId}/photo-${i}.png`, project_id: projectId, created_at: ON_DAY, taken_at: takenAt, created_by: "fixture", deleted_at: null, caption: null, lat: null, lng: null, accuracy_m: null };
}
function receipt(id: string, document = false) {
  return { id, uploaded_by: "u1", project_id: JOB.projectId, pending_job_name: null,
    photo_path: `install-media/receipts/${id}.png`, document_path: document ? `install-media/receipts/${id}.pdf` : null,
    amount_cents: 4210, vendor: "Same Vendor", purchased_on: "2026-10-05", category: "gas",
    category_by: "ai", is_passthrough: false, note: null, ocr: null, created_at: ON_DAY,
    reviewed_by: null, reviewed_at: null, cost_code_id: null, job_cost_id: null,
    projects: { job_code: JOB.jobCode, name: "Fixture job" }, profiles: { display_name: "Fixture" } };
}

type RestRow = PhotoRow | ReturnType<typeof receipt>;
function fulfillRows(route: Route, rows: RestRow[], total: number) {
  const url = new URL(route.request().url());
  const start = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? rows.length);
  const page = rows.slice(start, start + limit);
  return route.fulfill({ status: 200, contentType: "application/json",
    headers: { "content-range": `${start}-${Math.max(start, start + page.length - 1)}/${total}`, "access-control-expose-headers": "content-range" },
    body: JSON.stringify(page) });
}

async function useMediaExportFixtures(page: Page, kind: "photo" | "receipt", rows: RestRow[], opts: { missing?: string; holdSign?: boolean; share?: "success" | "cancel"; language?: "en" | "es"; photoPayload?: Buffer } = {}) {
  // Fixture setup is an async browser helper, not a React hook.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  await useSupabaseFixtures(page, { role: kind === "receipt" ? "supervisor" : "foreman", language: opts.language });
  await hideWrongProjectBanner(page);
  const exportQueries: URL[] = [];
  const exportRanges: string[] = [];
  const signed: string[] = [];
  let signHeld = false;
  let releaseSign = () => {};
  const heldSign = new Promise<void>(resolve => { releaseSign = resolve; });
  let signHoldArmed = false;
  await page.route("**/rest/v1/attachments**", route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("select") === "id,storage_path,created_at,taken_at,project_id") {
      exportQueries.push(url);
      exportRanges.push(`${url.searchParams.get("offset") ?? "0"}-${Number(url.searchParams.get("offset") ?? 0) + Number(url.searchParams.get("limit") ?? 0) - 1}`);
    }
    const project = url.searchParams.get("project_id")?.replace(/^eq\./, "");
    const queryKind = url.searchParams.get("kind")?.replace(/^eq\./, "");
    const excludedPaths = url.searchParams.getAll("storage_path")
      .filter(value => value.startsWith("not.like."))
      .map(value => value.slice("not.like.".length).replace(/%$/, ""));
    const or = url.searchParams.get("or") ?? "";
    const cursorTimes = [...or.matchAll(/created_at\.lt\."([^"]+)"/g)];
    const cursorTime = or.includes("id.lt") ? cursorTimes.at(-1)?.[1] : undefined;
    const cursorId = /id\.lt\."([^"]+)"/.exec(or)?.[1];
    const since = /taken_at\.gte\."([^"]+)"/.exec(or)?.[1];
    const before = /taken_at\.lt\."([^"]+)"/.exec(or)?.[1];
    const scoped = rows.filter((r): r is PhotoRow => "storage_path" in r &&
      (!project || r.project_id === project) &&
      (!queryKind || r.kind === queryKind) &&
      excludedPaths.every(prefix => !r.storage_path.startsWith(prefix)) &&
      (!since || (r.taken_at ?? r.created_at) >= since) &&
      (!before || (r.taken_at ?? r.created_at) < before) &&
      (!cursorTime || r.created_at < cursorTime || (r.created_at === cursorTime && !!cursorId && r.id < cursorId)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    // Keyset reads use limit with no offset. Other feed reads still use offset.
    return fulfillRows(route, scoped, scoped.length);
  });
  await page.route("**/rest/v1/receipts**", route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("offset")) { exportQueries.push(url); exportRanges.push(`${url.searchParams.get("offset")}-${Number(url.searchParams.get("offset")) + Number(url.searchParams.get("limit")) - 1}`); }
    const project = url.searchParams.get("project_id")?.replace(/^eq\./, "");
    const category = url.searchParams.get("category")?.replace(/^eq\./, "");
    const billing = url.searchParams.get("is_passthrough")?.replace(/^eq\./, "");
    const dateClauses = url.searchParams.getAll("created_at");
    const since = dateClauses.find(clause => clause.startsWith("gte."))?.slice(4);
    const before = dateClauses.find(clause => clause.startsWith("lt."))?.slice(3);
    const scoped = rows.filter((r): r is ReturnType<typeof receipt> => "photo_path" in r &&
      (!project || r.project_id === project) && (!category || r.category === category) &&
      (!billing || String(r.is_passthrough) === billing) &&
      (!since || r.created_at >= since) && (!before || r.created_at < before));
    return fulfillRows(route, scoped, scoped.length);
  });
  await page.route("**/storage/v1/**", async route => {
    const url = new URL(route.request().url());
    const sign = url.pathname.split("/object/sign/install-media/")[1];
    if (sign) {
      const path = decodeURIComponent(sign);
      signed.push(path);
      if (opts.holdSign && signHoldArmed) { signHeld = true; await heldSign; }
      if (opts.missing && path.includes(opts.missing)) return route.fulfill({ status: 404, contentType: "application/json", body: '{"message":"Missing fixture file"}' });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signedURL: `/object/authenticated/install-media/${path}` }) });
    }
    const path = decodeURIComponent(url.pathname.split("/object/authenticated/install-media/")[1] ?? "");
    if (opts.missing && path.includes(opts.missing)) return route.fulfill({ status: 404, body: "missing" });
    return route.fulfill({ status: 200, contentType: path.endsWith(".pdf") ? "application/pdf" : "image/png", body: path.endsWith(".pdf") ? PDF : (opts.photoPayload ?? PNG) });
  });
  if (opts.share) {
    await page.addInitScript(mode => {
      (window as Window & { __shared?: { name: string; bytes: number[] }[] }).__shared = [];
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", { configurable: true, value: async (data: ShareData) => {
        (window as Window & { __shareActivation?: boolean }).__shareActivation = navigator.userActivation?.isActive === true;
        const files = (data.files ?? []) as File[];
        (window as Window & { __shared?: { name: string; bytes: number[] }[] }).__shared = await Promise.all(files.map(async file => ({ name: file.name, bytes: [...new Uint8Array(await file.arrayBuffer())] })));
        if (mode === "cancel") throw new DOMException("Canceled", "AbortError");
      } });
    }, opts.share);
  } else {
    await page.addInitScript(() => { Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined }); });
  }
  return { exportQueries, exportRanges, signed, isSignHeld: () => signHeld, releaseSign, armSignHold: () => { signHoldArmed = true; } };
}

async function openExport(page: Page, kind: "photo" | "receipt", office = false) {
  await page.goto(office ? "/receipts" : `/photos?kind=${kind}&project=${JOB.projectId}`);
  await page.getByRole("button", { name: office ? "Export receipt files" : kind === "photo" ? "Export photos" : "Export receipts" }).click();
  const dialog = page.getByRole("dialog", { name: kind === "photo" ? "Export photos" : "Export receipts" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function downloadedZip(page: Page, buttonName: string, testInfo: TestInfo) {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: buttonName }).click();
  const download = await event;
  const path = testInfo.outputPath(`media-export-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await download.saveAs(path);
  return JSZip.loadAsync(readFileSync(path));
}

for (const { width, height } of [{ width: 390, height: 844 }, { width: 859, height: 844 }, { width: 860, height: 844 }, { width: 1280, height: 711 }]) {
  for (const kind of ["photo", "receipt"] as const) {
    test(`${kind} export dialog fits a ${width}x${height} viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      if (width === 860) await page.emulateMedia({ reducedMotion: "reduce" });
      await useMediaExportFixtures(page, kind, [kind === "photo" ? photo(1) : receipt("receipt-1")]);
      const dialog = await openExport(page, kind);
      // The sheet enters from below; measure after its mount animation settles.
      await expect.poll(async () => {
        const b = await dialog.boundingBox();
        return !!b && b.x >= -1 && b.y >= -1 && b.x + b.width <= width + 1 && b.y + b.height <= height + 1 &&
          (width < 860 || (Math.abs(b.x + b.width / 2 - width / 2) <= 2 && Math.abs(b.y + b.height / 2 - height / 2) <= 2));
      }).toBe(true);
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.y).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
      if (width >= 860) {
        expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThanOrEqual(2);
        expect(Math.abs(box!.y + box!.height / 2 - height / 2)).toBeLessThanOrEqual(2);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(dialog.getByRole("button", { name: "Close" })).toBeInViewport();
      const prepare = dialog.getByRole("button", { name: kind === "photo" ? "Export selected job" : "Prepare export" });
      await prepare.scrollIntoViewIfNeeded();
      await expect(prepare).toBeInViewport();
    });
  }
}

test("photo export pages past 60 and packages all 500 selected photos across numbered parts", async ({ page }, testInfo) => {
  const rows = Array.from({ length: 501 }, (_, i) => photo(i));
  rows[0] = photo(0, JOB.projectId, "2026-10-05T06:00:00Z");
  rows[500] = photo(500, JOB.projectId, "2026-10-06T05:59:00Z");
  rows.push(photo(999, OTHER.projectId), photo(998, JOB.projectId, "2026-10-04T18:00:00Z"));
  const { exportQueries } = await useMediaExportFixtures(page, "photo", rows);
  const dialog = await openExport(page, "photo");
  await dialog.getByLabel("Custom dates").check();
  await dialog.getByLabel("From date").fill("2026-10-05");
  await dialog.getByLabel("Through date").fill("2026-10-05");
  await expect(dialog.getByText("1 jobs · 501 / 501 photos selected")).toBeVisible();
  await dialog.getByRole("button", { name: "Expand" }).click();
  await expect(dialog.locator('.media-export-group .media-export-items input[type="checkbox"]')).toHaveCount(50);
  await dialog.locator('.media-export-group .media-export-items input[type="checkbox"]').first().uncheck();
  await expect(dialog.getByText("1 jobs · 500 / 501 photos selected")).toBeVisible();
  await dialog.getByRole("button", { name: "Export selected job" }).click();
  const seen = new Set<string>();
  let parts = 0;
  for (;;) {
    await expect(dialog.getByRole("button", { name: "Download ZIP" })).toBeVisible({ timeout: 90_000 });
    const zip = await downloadedZip(page, "Download ZIP", testInfo);
    const entries = Object.values(zip.files).filter(file => !file.dir);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(200);
    for (const entry of entries) {
      expect(entry.name).toContain(JOB.jobCode);
      const id = /photo-\d+/.exec(entry.name)?.[0];
      expect(id).toBeTruthy();
      expect(seen.has(id!)).toBe(false);
      seen.add(id!);
      expect(await entry.async("nodebuffer")).toEqual(PNG);
    }
    parts++;
    const next = dialog.getByRole("button", { name: "I saved this part — prepare next" });
    if (await next.count() === 0) break;
    await next.click();
  }
  expect(parts).toBe(3);
  expect(seen.size).toBe(500);
  expect(seen.has("photo-000")).toBe(true);
  expect(seen.has("photo-500")).toBe(false);
  expect(exportQueries.some(u => u.searchParams.get("project_id") === `eq.${JOB.projectId}`)).toBe(true);
  expect(exportQueries.some(u => u.searchParams.has("or"))).toBe(true);
  expect(exportQueries.some(u => (u.searchParams.get("or") ?? "").includes("id.lt"))).toBe(true);
});

test("job photo content excludes receipt attachments and receipt paths, and switching content resets prepared files", async ({ page }, testInfo) => {
  const legacyReceipt = { ...photo(2), id: "legacy-receipt", kind: "document", storage_path: "install-media/receipts/legacy-receipt.png" };
  const mislabelledReceipt = { ...photo(3), id: "mislabelled-receipt", storage_path: "install-media/receipts/mislabelled-receipt.png" };
  const { exportQueries } = await useMediaExportFixtures(page, "receipt", [
    photo(1), legacyReceipt, mislabelledReceipt, receipt("receipt-only"),
  ]);
  const dialog = await openExport(page, "photo");
  const content = dialog.getByLabel("Export content");
  await expect(content).toHaveValue("photo");
  await expect(dialog.getByText("1 jobs · 1 / 1 photos selected")).toBeVisible();
  const photoQuery = exportQueries.find(url => url.pathname.endsWith("/attachments") && url.searchParams.get("kind") === "eq.photo");
  expect(photoQuery?.searchParams.get("kind")).toBe("eq.photo");
  expect(photoQuery?.searchParams.getAll("storage_path")).toContain("not.like.install-media/receipts/%");
  expect(photoQuery?.searchParams.getAll("storage_path")).toContain("not.like.receipts/%");
  expect(exportQueries.some(url => url.pathname.endsWith("/receipts"))).toBe(false);
  await dialog.getByRole("button", { name: "Export selected job" }).click();
  await expect(dialog.getByText(/1 of 1 selected photos prepared/)).toBeVisible();
  const photoZip = await downloadedZip(page, "Download ZIP", testInfo);
  const photoNames = Object.values(photoZip.files).filter(file => !file.dir).map(file => file.name);
  expect(photoNames).toHaveLength(1);
  expect(photoNames[0]).toContain("photo-001");
  await content.selectOption("receipt");
  const receiptsDialog = page.getByRole("dialog", { name: "Export receipts" });
  await expect(receiptsDialog.getByText("1 / 1 selected")).toBeVisible();
  await expect(receiptsDialog.getByRole("button", { name: "Download ZIP" })).toHaveCount(0);
  await receiptsDialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(receiptsDialog.getByText("1 files ready")).toBeVisible();
  const receiptZip = await downloadedZip(page, "Download ZIP", testInfo);
  const receiptNames = Object.values(receiptZip.files).filter(file => !file.dir).map(file => file.name);
  expect(receiptNames).toHaveLength(1);
  expect(receiptNames[0]).toContain("receipt-only");
  await receiptsDialog.getByLabel("Export content").selectOption("photo");
  await expect(dialog.getByText("1 jobs · 1 / 1 photos selected")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Download ZIP" })).toHaveCount(0);
});

test("office receipt export retains original PDF and both images when vendor and date collide", async ({ page }, testInfo) => {
  const { signed } = await useMediaExportFixtures(page, "receipt", [receipt("receipt-a", true), receipt("receipt-b")]);
  const dialog = await openExport(page, "receipt", true);
  await expect(dialog.getByText("2 / 2 selected")).toBeVisible();
  await dialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(dialog.getByText("3 files ready")).toBeVisible();
  const zip = await downloadedZip(page, "Download ZIP", testInfo);
  const entries = Object.values(zip.files).filter(file => !file.dir);
  expect(entries).toHaveLength(3);
  expect(new Set(entries.map(entry => entry.name)).size).toBe(3);
  expect(entries.filter(entry => entry.name.endsWith(".pdf"))).toHaveLength(1);
  for (const entry of entries) expect(await entry.async("nodebuffer")).toEqual(entry.name.endsWith(".pdf") ? PDF : PNG);
  expect(signed.filter(path => path.endsWith(".pdf"))).toHaveLength(1);
});

test("an unavailable original is named and available files still download", async ({ page }, testInfo) => {
  await useMediaExportFixtures(page, "receipt", [receipt("receipt-good"), receipt("receipt-missing", true)], { missing: "receipt-missing.png" });
  const dialog = await openExport(page, "receipt");
  await dialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(dialog.getByText("2 files ready")).toBeVisible();
  await expect(dialog.getByText(/Some files could not be exported/)).toBeVisible();
  const zip = await downloadedZip(page, "Download available files", testInfo);
  const entries = Object.values(zip.files).filter(file => !file.dir);
  expect(entries).toHaveLength(2);
  for (const entry of entries) expect(await entry.async("nodebuffer")).toEqual(entry.name.endsWith(".pdf") ? PDF : PNG);
});

for (const mode of ["success", "cancel"] as const) {
  test(`share needs a separate tap after Prepare and ${mode === "cancel" ? "cancellation stays quiet" : "passes actual File bytes"}`, async ({ page }) => {
    await useMediaExportFixtures(page, "receipt", [receipt("receipt-share", true)], { share: mode });
    const dialog = await openExport(page, "receipt");
    await expect(dialog.getByRole("button", { name: "Share / Email" })).toHaveCount(0);
    const downloads: string[] = [];
    page.on("download", download => downloads.push(download.suggestedFilename()));
    await dialog.getByRole("button", { name: "Prepare export" }).click();
    await expect(dialog.getByText("2 files ready")).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __shared?: unknown[] }).__shared)).toEqual([]);
    await dialog.getByRole("button", { name: "Share / Email" }).click();
    await expect.poll(() => page.evaluate(() => (window as Window & { __shared?: unknown[] }).__shared?.length ?? 0)).toBe(2);
    expect(await page.evaluate(() => (window as Window & { __shareActivation?: boolean }).__shareActivation)).toBe(true);
    const shared = await page.evaluate(() => (window as Window & { __shared?: { name: string; bytes: number[] }[] }).__shared ?? []);
    expect(shared).toHaveLength(2);
    for (const file of shared) expect(Buffer.from(file.bytes)).toEqual(file.name.endsWith(".pdf") ? PDF : PNG);
    await expect(dialog.getByRole("button", { name: "Share / Email" })).toBeEnabled();
    expect(downloads).toEqual([]);
    if (mode === "cancel") await expect(dialog.getByRole("alert")).toHaveCount(0);
  });
}

test("Spanish export fits 320px and offers download when native sharing is absent", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await useMediaExportFixtures(page, "photo", [photo(1)], { language: "es" });
  await page.goto(`/photos?kind=photo&project=${JOB.projectId}`);
  await page.getByRole("button", { name: "Exportar fotos" }).click();
  const dialog = page.getByRole("dialog", { name: "Exportar fotos" });
  await dialog.getByRole("button", { name: "Exportar trabajo seleccionado" }).click();
  await expect(dialog.getByRole("button", { name: "Descargar ZIP" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Compartir ZIP" })).toBeDisabled();
  const width = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport);
  await expect(dialog.getByRole("button", { name: "Descargar ZIP" })).toBeInViewport();
  if (process.env.MEDIA_EXPORT_SCREENSHOT_PATH) await page.screenshot({ path: process.env.MEDIA_EXPORT_SCREENSHOT_PATH });
});

test("incomplete and reversed custom dates disable Prepare without an export read", async ({ page }) => {
  const { exportQueries } = await useMediaExportFixtures(page, "photo", [photo(1)]);
  const dialog = await openExport(page, "photo");
  await expect(dialog.getByText("1 jobs · 1 / 1 photos selected")).toBeVisible();
  const before = exportQueries.length;
  await dialog.getByLabel("Custom dates").check();
  await expect(dialog.getByRole("button", { name: "Export selected job" })).toBeDisabled();
  await dialog.getByLabel("From date").fill("2026-10-06");
  await dialog.getByLabel("Through date").fill("2026-10-05");
  await expect(dialog.getByRole("button", { name: "Export selected job" })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText(/valid start and end dates/);
  expect(exportQueries).toHaveLength(before);
});

test("Cancel preparation releases a pending storage sign without sharing or downloading", async ({ page }) => {
  const { signed, isSignHeld, releaseSign, armSignHold } = await useMediaExportFixtures(page, "photo", [photo(1)], { holdSign: true, share: "success" });
  const downloads: string[] = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));
  const dialog = await openExport(page, "photo");
  await expect(dialog.getByText("1 jobs · 1 / 1 photos selected")).toBeVisible();
  await expect.poll(() => signed.length).toBeGreaterThan(0); // Let the feed's thumbnail sign finish first.
  armSignHold();
  try {
    await dialog.getByRole("button", { name: "Export selected job" }).click();
    await expect.poll(isSignHeld).toBe(true);
    await expect(dialog.getByRole("button", { name: "Cancel preparation" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel preparation" }).click();
    await expect(dialog.getByRole("button", { name: "Cancel preparation" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Export selected job" })).toBeEnabled();
    await expect(dialog.getByText("Preparation was canceled.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Download ZIP" })).toHaveCount(0);
    releaseSign(); // A late signing response must not start a file fetch.
    expect(downloads).toEqual([]);
    expect(await page.evaluate(() => (window as Window & { __shared?: unknown[] }).__shared)).toEqual([]);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toHaveCount(0);
  } finally { releaseSign(); }
});

test("office month, category and billing filters carry into receipt files", async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-10-06T18:00:00Z"));
  const rows = [
    receipt("receipt-target"),
    { ...receipt("receipt-other-category"), category: "other" },
    { ...receipt("receipt-billed"), is_passthrough: true },
    { ...receipt("receipt-september"), created_at: "2026-09-05T18:00:00Z", purchased_on: "2026-09-05" },
  ];
  const { exportQueries } = await useMediaExportFixtures(page, "receipt", rows);
  await page.goto("/receipts");
  await page.getByLabel("Filter by month").selectOption("2026-10");
  await page.getByLabel("Filter by category").selectOption("gas");
  await page.getByLabel("Filter by billing").selectOption("no");
  await page.getByLabel("Filter by job").selectOption(JOB.projectId);
  await page.getByRole("button", { name: "Export receipt files" }).click();
  const dialog = page.getByRole("dialog", { name: "Export receipts" });
  await expect(dialog.getByText("1 / 1 selected")).toBeVisible();
  await expect(dialog.getByText(/office month, category and billing filters also apply/)).toBeVisible();
  await dialog.getByRole("button", { name: "Prepare export" }).click();
  await expect(dialog.getByText("1 files ready")).toBeVisible();
  const zip = await downloadedZip(page, "Download ZIP", testInfo);
  const entries = Object.values(zip.files).filter(file => !file.dir);
  expect(entries).toHaveLength(1);
  expect(entries[0].name).toContain("receipt-target");
  expect(await entries[0].async("nodebuffer")).toEqual(PNG);
  expect(exportQueries.some(url => url.searchParams.get("category") === "eq.gas" && url.searchParams.get("is_passthrough") === "eq.false" && url.searchParams.get("project_id") === `eq.${JOB.projectId}` && url.searchParams.getAll("created_at").some(clause => clause.startsWith("gte.2026-10-01")) && url.searchParams.getAll("created_at").some(clause => clause.startsWith("lt.2026-11-01")))).toBe(true);
});

test("photo metadata keyset reads beyond 5000 without dropping rows", async ({ page }) => {
  const rows = Array.from({ length: 5001 }, (_, i) => photo(i));
  const { exportQueries } = await useMediaExportFixtures(page, "photo", rows);
  const dialog = await openExport(page, "photo");
  await expect(dialog.getByText("1 jobs · 5001 / 5001 photos selected")).toBeVisible({ timeout: 90_000 });
  expect(exportQueries.length).toBeGreaterThan(10);
  expect(exportQueries.some(url => (url.searchParams.get("or") ?? "").includes("id.lt"))).toBe(true);
  await expect(dialog.getByRole("button", { name: "Export selected job" })).toBeEnabled();
});

test("all-jobs photo ZIP contains job and Unassigned folders with independent job selection", async ({ page }, testInfo) => {
  const unassigned = { ...photo(3, JOB.projectId), project_id: null };
  const missingLabel = photo(4, "orphan-job-id");
  await useMediaExportFixtures(page, "photo", [photo(1), photo(5), photo(2, OTHER.projectId), unassigned, missingLabel]);
  const dialog = await openExport(page, "photo");
  await dialog.getByRole("button", { name: "All jobs I can access" }).click();
  await expect(dialog.getByText("4 jobs · 5 / 5 photos selected")).toBeVisible();
  const other = dialog.locator(".media-export-group").filter({ hasText: OTHER.jobCode });
  await other.locator('input[type="checkbox"]').first().uncheck();
  await expect(dialog.getByText("3 jobs · 4 / 5 photos selected")).toBeVisible();
  const orphan = dialog.locator(".media-export-group").filter({ hasText: "Job-orphan-job-id" });
  await expect(orphan).toBeVisible();
  const known = dialog.locator(".media-export-group").filter({ hasText: JOB.jobCode });
  await known.getByRole("button", { name: "Expand" }).click();
  const day = known.locator(".media-export-day button");
  await day.click();
  await expect(known.locator(".media-export-items li")).toHaveCount(0);
  await day.click();
  await expect(known.locator(".media-export-items li")).toHaveCount(2);
  await known.locator('.media-export-items input[type="checkbox"]').first().uncheck();
  await expect(dialog.getByText("3 jobs · 3 / 5 photos selected")).toBeVisible();
  await dialog.getByRole("button", { name: "Export all selected projects" }).click();
  const zip = await downloadedZip(page, "Download ZIP", testInfo);
  const names = Object.values(zip.files).filter(file => !file.dir).map(file => file.name);
  expect(names).toHaveLength(3);
  expect(names.some(name => name.includes(JOB.jobCode) && name.includes("photo-001"))).toBe(true);
  expect(names.some(name => name.startsWith("Unassigned/") && name.includes("photo-003"))).toBe(true);
  expect(names.some(name => name.startsWith("Job-orphan-j/") && name.includes("photo-004"))).toBe(true);
  expect(names.every(name => !name.includes(OTHER.jobCode) && !name.includes("photo-005"))).toBe(true);
});


test("more than 50 MB of selected photo bytes packs into separate ZIP parts", async ({ page }, testInfo) => {
  const payload = Buffer.alloc(6 * 1024 * 1024, 0x5a);
  const rows = Array.from({ length: 10 }, (_, i) => photo(i));
  await useMediaExportFixtures(page, "photo", rows, { photoPayload: payload });
  const dialog = await openExport(page, "photo");
  await expect(dialog.getByText("1 jobs · 10 / 10 photos selected")).toBeVisible();
  await dialog.getByRole("button", { name: "Export selected job" }).click();
  const seen = new Set<string>();
  let parts = 0;
  for (;;) {
    await expect(dialog.getByRole("button", { name: "Download ZIP" })).toBeVisible({ timeout: 90_000 });
    const zip = await downloadedZip(page, "Download ZIP", testInfo);
    const entries = Object.values(zip.files).filter(file => !file.dir);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(await entry.async("nodebuffer")).toEqual(payload);
      const id = /photo-\d+/.exec(entry.name)?.[0];
      expect(id).toBeTruthy(); expect(seen.has(id!)).toBe(false); seen.add(id!);
    }
    parts++;
    const next = dialog.getByRole("button", { name: "I saved this part — prepare next" });
    if (await next.count() === 0) break;
    await next.click();
  }
  expect(parts).toBeGreaterThan(1);
  expect(seen.size).toBe(10);
  await expect(dialog.getByText(/10 of 10 selected photos prepared across/)).toBeVisible();
});

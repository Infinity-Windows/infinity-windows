// A signed-in installed phone opens on-demand features after losing signal.
// The production harness serves a real build with a service worker. Its
// fixture Supabase host cannot reach production, and this spec only reads
// screens and types an ID; it never submits a business operation.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner } from "./support/specHelpers";
import { cutTheNetwork, failedAppFiles, harnessState, serveBuild, serviceWorkerReady } from "./support/pwa";

const BLACK22 = jobFixtures().find((job) => job.jobCode === "BLACK22")!;

/** Read the built Scanner chunk's actual dynamic import, not a guessed vendor filename. */
async function decoderPath(request: APIRequestContext): Promise<string> {
  const { builds } = await harnessState(request);
  const assets = join(builds.new.dir, "assets");
  const scanner = readdirSync(assets).find((name) => /^Scanner-[\w-]+\.js$/.test(name));
  expect(scanner, "the production build has a Scanner chunk").toBeDefined();
  const source = readFileSync(join(assets, scanner!), "utf8");
  const imports = [...source.matchAll(/import\([`"']\.\/([^`"']+\.js)[`"']\)/g)].map((match) => match[1]);
  expect(imports, "Scanner has exactly one on-demand camera decoder import").toHaveLength(1);
  return `/assets/${imports[0]}`;
}

test("lazy job tabs and scanner manual entry still open from the worker cache offline", async ({ page, context, request }) => {
  // Foreman is the least-privileged fixture role that can see Dispatch and
  // signature estimates. None of the three job tabs or the scanner is opened
  // before the network is cut, so their chunks must come from the worker.
  await useSupabaseFixtures(page, { role: "foreman" });
  await hideWrongProjectBanner(page);
  await serveBuild(request, "new");
  const cameraDecoder = await decoderPath(request);
  await page.goto("/");
  await expect(page.locator(".app-main")).toBeVisible();
  await serviceWorkerReady(page);

  await cutTheNetwork(page, context); // includes browser HTTP cache eviction
  const failed = failedAppFiles(page);
  await page.reload();
  await expect(page.locator(".app-main"), "signed-in shell starts offline").toBeVisible();

  const job = `/projects/${BLACK22.projectId}`;
  await page.goto(`${job}?tab=warehouse`);
  await expect(page.getByRole("heading", { name: "Plan packages & labels" }), "package planning chunk loads offline").toBeVisible();
  expect(failed, "app files missing while opening package planning").toEqual([]);

  await page.goto(`${job}?tab=dispatch`);
  await expect(page.getByRole("heading", { name: "Dispatch", exact: true }), "dispatch chunk loads offline").toBeVisible();
  expect(failed, "app files missing while opening dispatch").toEqual([]);

  await page.goto(`${job}?tab=brain`);
  await expect(page.getByRole("heading", { name: "Estimates — by signature" }), "signature-estimates chunk loads offline").toBeVisible();
  expect(failed, "app files missing while opening signature estimates").toEqual([]);

  await page.goto("/warehouse");
  const find = page.locator(".wh-find");
  await expect(find).toBeVisible();
  // Wait for the decoder's own chunk, served by the worker after the browser
  // cache was cleared. Manual entry alone could pass before a missing camera
  // import settled, so it is checked only after the decoder response.
  const decoderResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === cameraDecoder,
    { timeout: 15_000 },
  );
  await find.getByRole("button", { name: "Scan", exact: true }).click();
  const decoder = await decoderResponse;
  expect(decoder.status(), "camera decoder chunk loads successfully offline").toBe(200);
  expect(decoder.fromServiceWorker(), "the decoder comes from the installed worker, not the network").toBe(true);
  const scanner = find.locator(".scanner");
  const manual = scanner.locator(".manual-entry input");
  await expect(manual, "scanner and its manual-entry fallback load offline").toBeVisible();
  await manual.fill("CTR-000003");
  await scanner.locator(".manual-entry button").click();
  await expect(find.locator(".locate-search input"), "typed ID reaches warehouse find without a camera or write").toHaveValue("CTR-000003");
  expect(failed, "app files missing while opening scanner and manual entry").toEqual([]);
});

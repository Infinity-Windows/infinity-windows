// Branden's stale clock: an old open shift can be on this phone while the
// authoritative time_shifts read is failing. Reload through the real app's
// persisted React Query cache, then recover through its own Check again UI.
// No punch, finish-time or other business write is made by this spec.

import { expect, test, type Page, type Route } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import { GENERAL, morningFixtures, OAKRIDGE } from "./support/release1Fixtures";

const SHIFT_ID = "55555555-eeee-4eee-8eee-555555555555";
const oldAt = () => new Date(Date.now() - 39 * 24 * 3600_000).toISOString();
const currentAt = () => new Date(Date.now() - 60 * 60_000).toISOString();

function shift(clockIn: string) {
  return {
    id: SHIFT_ID,
    profile_id: TEST_USER.id,
    project_id: OAKRIDGE,
    cost_code_id: GENERAL,
    clock_in_at: clockIn,
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: clockIn,
    note: null,
    projects: { job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" },
    cost_codes: { code: "000", label: "General" },
  };
}

type ServerAnswer = "old" | "failed" | "current" | "none" | "held";

async function evidenceShot(page: Page, name: string) {
  const dir = process.env.CLOCK_REFRESH_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Override only the app's open-shift read, leaving normal fixture traffic intact. */
async function clockReadServer(page: Page, initialOldAt: string) {
  const held: { route: Route; done: () => void }[] = [];
  const state = {
    answer: "old" as ServerAnswer, failedReads: 0, successfulReads: 0, heldReads: 0, writes: [] as string[],
    async releaseHeld(reply: "abort" | "none") {
      const waiting = held.splice(0);
      await Promise.all(waiting.map(async ({ route, done }) => {
        try {
          if (reply === "abort") await route.abort("timedout");
          else {
            state.successfulReads++;
            await json(route, [], 0);
          }
        } catch {
          // A timed-out request may already have been cancelled by the app.
        } finally {
          done();
        }
      }));
    },
  };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (/\/rest\/v1\/rpc\/(clock_in|clock_out|start_break|end_break)(\?|$)/.test(url.href) ||
        (url.pathname.endsWith("/time_shifts") && request.method() !== "GET")) {
      state.writes.push(`${request.method()} ${url.pathname}`);
    }
  });
  await page.route("**/rest/v1/time_shifts**", (route: Route) => {
    const url = new URL(route.request().url());
    if (!(url.searchParams.get("status") ?? "").startsWith("in.")) return route.fallback();
    if (state.answer === "held") {
      state.heldReads++;
      return new Promise<void>((done) => held.push({ route, done }));
    }
    if (state.answer === "failed") {
      state.failedReads++;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "PGRST503", message: "Clock read unavailable" }),
      });
    }
    state.successfulReads++;
    const row = state.answer === "old" ? shift(initialOldAt) : state.answer === "current" ? shift(currentAt()) : null;
    return json(route, row ? [row] : [], row ? 1 : 0);
  });
  return state;
}

/** Wait for the app's own persister to save the first server result. */
async function savedOldShift(page: Page, initialOldAt: string) {
  await expect.poll(async () => page.evaluate(({ id, at, shiftId }) => {
    const raw = localStorage.getItem("wops-query-cache");
    if (!raw) return false;
    const saved = JSON.parse(raw) as {
      clientState?: { queries?: { queryKey?: unknown[]; state?: { data?: { id?: string; clock_in_at?: string } } }[] };
    };
    return (saved.clientState?.queries ?? []).some((query) =>
      query.queryKey?.[0] === "openShift" && query.queryKey?.[1] === id &&
      query.state?.data?.id === shiftId && query.state.data.clock_in_at === at);
  }, { id: TEST_USER.id, at: initialOldAt, shiftId: SHIFT_ID }), { message: "the old shift was not saved by the real query persister" }).toBe(true);
}

async function savedNullShift(page: Page) {
  await expect.poll(async () => page.evaluate((id) => {
    const raw = localStorage.getItem("wops-query-cache");
    if (!raw) return false;
    const saved = JSON.parse(raw) as {
      clientState?: { queries?: { queryKey?: unknown[]; state?: { status?: string; data?: unknown } }[] };
    };
    return (saved.clientState?.queries ?? []).some((query) =>
      query.queryKey?.[0] === "openShift" && query.queryKey?.[1] === id &&
      query.state?.status === "success" && query.state.data === null);
  }, TEST_USER.id), { message: "the verified null was not saved by the real query persister" }).toBe(true);
}

test.use({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });

for (const scenario of [
  { language: "en" as const, recovery: "current" as const, check: "Check clock", retry: "Check again", unavailable: "Cannot check your clock" },
  { language: "es" as const, recovery: "none" as const, check: "Verificar reloj", retry: "Verificar de nuevo", unavailable: "No se puede verificar tu reloj" },
]) {
  test(`${scenario.language}: failed read of saved 39-day shift stays neutral until Check again verifies ${scenario.recovery}`, async ({ page }) => {
    await useSupabaseFixtures(page, { role: "installer", uiDesign: "new", language: scenario.language });
    await hideWrongProjectBanner(page);
    await stubGeolocationDenied(page);
    await morningFixtures(page, { signed: true, openShift: false });
    const initialOldAt = oldAt();
    const server = await clockReadServer(page, initialOldAt);

    // First launch genuinely receives the old row and saves it to the phone.
    await page.goto("/");
    await expect(page.getByTestId("clock-badge")).toBeVisible();
    await savedOldShift(page, initialOldAt);
    expect(server.successfulReads).toBeGreaterThan(0);

    // On the next launch, the browser hydrates that row before Forge answers.
    // The read fails; an old timer or an assumed Start would be unsafe.
    server.answer = "failed";
    await page.reload();
    await expect.poll(() => server.failedReads).toBeGreaterThan(0);
    const badge = page.getByTestId("clock-badge");
    await expect(badge).toContainText(scenario.check);
    await expect(badge).not.toContainText(/Finish time|¿Hora de salida\?|Clocked in|Entrada|\d{2,}:\d{2}/);
    const workNotice = page.getByTestId("work-screen").getByTestId("clock-read-notice");
    await expect(workNotice.getByRole("heading", { name: scenario.unavailable })).toBeVisible();
    await expect(workNotice.getByRole("button", { name: scenario.retry, exact: true })).toBeEnabled();
    await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
    expect(server.writes).toEqual([]);

    // The top badge must open the same safe clock sheet without offering a
    // saved finish or a new punch while the read is still unknown.
    await badge.click();
    const sheet = page.locator(".clock-sheet");
    await expect(sheet).toBeVisible();
    const sheetNotice = sheet.getByTestId("clock-read-notice");
    await expect(sheetNotice.getByRole("heading", { name: scenario.unavailable })).toBeVisible();
    await expect(sheetNotice.getByRole("button", { name: scenario.retry, exact: true })).toBeEnabled();
    await expect(sheet.getByRole("button", { name: /Save|Guardar|Clock in|Entrada|Start day|Iniciar día/ })).toHaveCount(0);
    expect(server.writes).toEqual([]);

    // Retry the actual read. A current shift restores the live clock; a
    // verified null releases Start day. Neither transition writes a punch.
    server.answer = scenario.recovery;
    const readsBeforeRetry = server.successfulReads;
    await sheetNotice.getByRole("button", { name: scenario.retry, exact: true }).click();
    await expect.poll(() => server.successfulReads).toBeGreaterThan(readsBeforeRetry);
    if (scenario.recovery === "current") {
      await expect(page.getByTestId("clock-badge")).toContainText(/Clocked in|Entrada/);
      await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("clock-badge")).toHaveCount(0);
      await expect(page.getByTestId("ws-start-day")).toBeEnabled();
    }
    expect(server.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("English: a hung read reaches neutral recovery within the 15-second deadline, then Check again verifies today's shift", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new", language: "en" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, openShift: false });
  const initialOldAt = oldAt();
  const server = await clockReadServer(page, initialOldAt);
  await page.goto("/");
  await expect(page.getByTestId("clock-badge")).toBeVisible();
  await savedOldShift(page, initialOldAt);

  server.answer = "held";
  await page.reload();
  await expect.poll(() => server.heldReads).toBeGreaterThan(0);
  const started = Date.now();
  const notice = page.getByTestId("work-screen").getByTestId("clock-read-notice");
  await expect(notice.getByRole("heading", { name: "Cannot check your clock" })).toBeVisible({ timeout: 25_000 });
  expect(Date.now() - started, "the read should wait for its 15-second deadline before failing").toBeGreaterThanOrEqual(13_000);
  await expect(page.getByTestId("clock-badge")).toContainText("Check clock");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  await evidenceShot(page, "clock-refresh-hung-recovered-en");
  expect(server.writes).toEqual([]);

  server.answer = "current";
  await server.releaseHeld("abort");
  const readsBeforeRetry = server.successfulReads;
  await notice.getByRole("button", { name: "Check again", exact: true }).click();
  await expect.poll(() => server.successfulReads).toBeGreaterThan(readsBeforeRetry);
  await expect(page.getByTestId("clock-badge")).toContainText("Clocked in");
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  expect(server.writes).toEqual([]);
});

test("Spanish: a saved null stays unknown while a new read is held, then Start appears after verified null", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new", language: "es" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, openShift: false });
  const server = await clockReadServer(page, oldAt());
  server.answer = "none";
  await page.goto("/");
  await expect(page.getByTestId("ws-start-day")).toBeEnabled();
  await savedNullShift(page);

  server.answer = "held";
  await page.reload();
  await expect.poll(() => server.heldReads).toBeGreaterThan(0);
  const notice = page.getByTestId("work-screen").getByTestId("clock-read-notice");
  await expect(notice.getByRole("heading", { name: "Verificando tu reloj" })).toBeVisible();
  await expect(page.getByTestId("ws-start-day")).toHaveCount(0);
  await evidenceShot(page, "clock-refresh-cached-null-checking-es");
  expect(server.writes).toEqual([]);

  await server.releaseHeld("none");
  await expect(page.getByTestId("ws-start-day")).toBeEnabled();
  await expect(notice).toHaveCount(0);
  expect(server.writes).toEqual([]);
});

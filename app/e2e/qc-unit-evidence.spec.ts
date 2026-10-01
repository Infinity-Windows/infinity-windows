import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures as installSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const OPENING_ID = "20000000-0000-4000-8000-000000000081";
const PROJECT_ID = "20000000-0000-4000-8000-000000000082";
const OPENING = {
  id: OPENING_ID, project_id: PROJECT_ID, opening_code: "11-1", status: "installed",
  assigned_window_id: null, window_types: { type_code: "W-11" },
  qc: null, projects: { job_code: "SSSIMISTER 11" },
};

test("QC offers a direct unit-details door before sign-off", async ({ page }) => {
  await installSupabaseFixtures(page, { role: "foreman" });
  await page.route("**/rest/v1/qc_checks**", route => json(route, []));
  await page.route("**/rest/v1/project_openings**", route => json(route, [OPENING], 1));
  await page.goto("/qc");
  await expect(page.getByText("11-1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View unit details", exact: true })).toHaveCount(1, { timeout: 2_000 });
  await expect(page.getByRole("button", { name: "Pass ✓", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Callback", exact: true })).toBeVisible();
});

const WINDOW_ID = "20000000-0000-4000-8000-000000000083";
const OLD_WINDOW_ID = "20000000-0000-4000-8000-000000000084";
const EVENT_ID = "20000000-0000-4000-8000-000000000085";
const OLD_EVENT_ID = "20000000-0000-4000-8000-000000000086";
const OTHER_OPENING_ID = "20000000-0000-4000-8000-000000000087";
const OTHER_PROJECT_ID = "20000000-0000-4000-8000-000000000088";
const FULL_OPENING = {
  ...OPENING, assigned_window_id: WINDOW_ID, label: "South elevation window",
  window_type_id: "20000000-0000-4000-8000-000000000089", page_number: 1,
  assigned_to: TEST_USER.id, confirmed: true, created_at: "2026-09-30T10:00:00Z",
  ro_width_in: 50, ro_height_in: 74, ro_measured_by: null, ro_measured_at: null,
  window_types: { id: "type-11", type_code: "W-11", name: "Commercial fixed unit", width_in: 48, height_in: 72, notes: "Check perimeter seal and sill pan" },
  windows: { id: WINDOW_ID, window_id: "WIN-11-1", project_id: PROJECT_ID, status: "installed", notes: "Keep drain paths clear" },
  projects: { id: PROJECT_ID, job_code: "SSSIMISTER 11", name: "Simister south elevation" },
  assignee: { id: TEST_USER.id, display_name: "Installer Example", role: "foreman", active: true, skill_level: 3 },
};
const OTHER_OPENING = {
  ...FULL_OPENING, id: OTHER_OPENING_ID, project_id: OTHER_PROJECT_ID,
  assigned_window_id: null, windows: null, label: "Different job unit",
  projects: { id: OTHER_PROJECT_ID, job_code: "OTHER JOB", name: "Separate job" },
};
const EVENTS = [
  { id: EVENT_ID, project_opening_id: OPENING_ID, window_id: WINDOW_ID, created_at: "2026-10-01T12:00:00Z", started_at: "2026-10-01T11:00:00Z", installer: "Installer Example", minutes: 60, quality_grade: 4, transcript_raw: "Current installation transcript", voided_at: null, void_reason: null, went_well: "Frame seated squarely", difficulty: null, went_poorly: null, obstacles: null, tools_helped: null, time_vs_estimate: null, safety_notes: null, do_again: null },
  { id: OLD_EVENT_ID, project_opening_id: OPENING_ID, window_id: OLD_WINDOW_ID, created_at: "2026-09-30T12:00:00Z", started_at: null, installer: "Earlier installer", minutes: 45, quality_grade: 3, transcript_raw: "Earlier installation transcript", voided_at: "2026-09-30T14:00:00Z", void_reason: "Replace damaged frame", went_well: null, difficulty: null, went_poorly: null, obstacles: null, tools_helped: null, time_vs_estimate: null, safety_notes: null, do_again: null },
];
function file(id: string, name: string, kind: "photo" | "voice_memo", targets: Record<string, unknown> = {}) {
  return { id, kind, storage_path: `install-media/${PROJECT_ID}/11-1/${name}`, project_id: PROJECT_ID, project_opening_id: null, install_event_id: null, window_id: null, package_id: null, service_case_id: null, created_at: "2026-10-01T12:00:00Z", created_by: "Installer Example", taken_at: null, caption: null, transcript: null, deleted_at: null, ...targets };
}
const FILES = [
  file("photo-current", "qc-after.jpg", "photo", { install_event_id: EVENT_ID, window_id: WINDOW_ID, caption: "Lower frame and sill" }),
  file("memo-current", "current-memo.wav", "voice_memo", { install_event_id: EVENT_ID, window_id: WINDOW_ID }),
  file("photo-old", "qc-before.jpg", "photo", { install_event_id: OLD_EVENT_ID, window_id: OLD_WINDOW_ID, project_id: null }),
  file("memo-old", "earlier-memo.wav", "voice_memo", { install_event_id: OLD_EVENT_ID, window_id: OLD_WINDOW_ID, project_id: null }),
  file("photo-direct", "unit-detail.jpg", "photo", { project_opening_id: OPENING_ID, caption: "Saved directly on the unit" }),
  file("photo-window", "assigned-window.jpg", "photo", { window_id: WINDOW_ID, caption: "Older assigned-window photo" }),
  file("conflicting-project", "forbidden-project.jpg", "photo", { install_event_id: EVENT_ID, project_id: OTHER_PROJECT_ID }),
  file("conflicting-event", "forbidden-event.jpg", "photo", { project_opening_id: OPENING_ID, install_event_id: "foreign-event" }),
  file("job-only", "forbidden-job.jpg", "photo"),
];
function silentWav() {
  const dataBytes = 16_000;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF", 0); b.writeUInt32LE(36 + dataBytes, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8_000, 24); b.writeUInt32LE(16_000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
interface EvidenceOptions {
  language?: "en" | "es";
  role?: "installer" | "foreman";
  emptyEvents?: boolean;
  onlyDirect?: boolean;
  emptyFiles?: boolean;
  twoUnits?: boolean;
}
async function evidenceFixtures(page: Page, options: EvidenceOptions = {}) {
  await installSupabaseFixtures(page, { role: options.role ?? "foreman", language: options.language ?? "en" });
  const state = { failFiles: false, failMemoSign: false, signedPaths: [] as string[], evidenceReads: 0, decisions: 0 };
  await page.route("**/rest/v1/qc_checks**", route => json(route, []));
  await page.route("**/rest/v1/rpc/record_qc_decision", route => { state.decisions++; return json(route, null); });
  await page.route("**/rest/v1/project_openings**", route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("id")?.startsWith("eq.")) {
      const row = params.get("id") === `eq.${OTHER_OPENING_ID}` ? OTHER_OPENING : FULL_OPENING;
      return json(route, row);
    }
    if (params.has("assigned_window_id")) {
      return json(route, params.get("id")?.startsWith("neq.") ? [] : [FULL_OPENING]);
    }
    return json(route, options.twoUnits ? [FULL_OPENING, OTHER_OPENING] : [FULL_OPENING], options.twoUnits ? 2 : 1);
  });
  await page.route("**/rest/v1/install_events**", route => {
    state.evidenceReads++;
    const params = new URL(route.request().url()).searchParams;
    if (params.get("project_opening_id")?.startsWith("neq.")) return json(route, []);
    if (params.get("project_opening_id") === `eq.${OTHER_OPENING_ID}`) return json(route, []);
    return json(route, options.emptyEvents ? [] : EVENTS);
  });
  await page.route("**/rest/v1/attachments**", route => {
    state.evidenceReads++;
    if (state.failFiles) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "secret_media_table unavailable" }) });
    if (options.emptyFiles) return json(route, []);
    const params = new URL(route.request().url()).searchParams;
    if (params.get("project_opening_id") === `eq.${OTHER_OPENING_ID}`) {
      return json(route, [file("second-photo", "second-unit.jpg", "photo", { project_id: OTHER_PROJECT_ID, project_opening_id: OTHER_OPENING_ID, storage_path: `install-media/${OTHER_PROJECT_ID}/11-1/second-unit.jpg` })]);
    }
    const direct = [file("direct-only-photo", "direct-only.jpg", "photo", { project_opening_id: OPENING_ID }), file("direct-only-memo", "direct-only.wav", "voice_memo", { project_opening_id: OPENING_ID, transcript: "Direct recording transcript" })];
    return json(route, options.onlyDirect ? direct : FILES);
  });
  await page.route("**/rest/v1/opening_phases**", route => {
    state.evidenceReads++;
    const params = new URL(route.request().url()).searchParams;
    if (options.emptyFiles || options.onlyDirect || params.get("opening_id") === `eq.${OTHER_OPENING_ID}`) return json(route, []);
    return json(route, [{ id: "phase-flashing", opening_id: OPENING_ID, kind: "flashing", status: "submitted", photo_path: `${PROJECT_ID}/11-1/flashing.jpg`, submitted_at: "2026-09-30T10:00:00Z", minutes: 25 }]);
  });
  await page.route("**/rest/v1/qc_decision_events**", route => json(route, [{ id: "decision-history", project_opening_id: OPENING_ID, status: "passed", note: "Earlier review", reviewer_id: null, decided_at: "2026-09-30T16:00:00Z", source: "review" }]));
  await page.route("**/storage/v1/object/sign/install-media/**", route => {
    const url = new URL(route.request().url());
    const path = url.pathname.split("/object/sign/install-media/")[1];
    if (route.request().method() === "POST") {
      state.signedPaths.push(path);
      if (state.failMemoSign && path.endsWith("current-memo.wav")) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "fixture unavailable" }) });
      return json(route, { signedURL: `/object/sign/install-media/${path}?token=fixture` });
    }
    return route.fulfill({ status: 200, contentType: path.endsWith(".wav") ? "audio/wav" : "image/png", body: path.endsWith(".wav") ? silentWav() : PNG });
  });
  return state;
}

test("phone QC opens unit facts, all saved rounds, photos and playable original memos without deciding", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await evidenceFixtures(page);
  await page.goto("/qc");
  expect(state.evidenceReads).toBe(0);
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  await expect(page.getByText("Commercial fixed unit", { exact: false })).toBeVisible();
  await expect(page.getByText("Frame seated squarely", { exact: true })).toBeVisible();
  for (const name of ["qc-after.jpg", "qc-before.jpg", "unit-detail.jpg", "flashing.jpg"]) {
    const photo = page.locator(`img[src*="${name}"]`);
    // WebKit waits until a lazy photo enters the viewport. Scroll its card,
    // which has a visible caption even before the photo acquires dimensions.
    await page.locator("figure").filter({ has: photo }).scrollIntoViewIfNeeded();
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.locator("audio")).toHaveCount(2);
  await expect(page.locator("figure").filter({ has: page.locator('img[src*="qc-before.jpg"]') })
    .getByText("Sent back · Replace damaged frame", { exact: true })).toBeVisible();
  await expect(page.locator("figure").filter({ has: page.locator('audio[src*="earlier-memo.wav"]') })
    .getByText("Sent back · Replace damaged frame", { exact: true })).toBeVisible();
  const memo = page.locator('audio[src*="current-memo.wav"]');
  await expect.poll(() => memo.evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThanOrEqual(2);
  await memo.evaluate(async (node: HTMLAudioElement) => { await node.play(); node.pause(); });
  expect(state.signedPaths.some(path => path.includes("forbidden"))).toBe(false);
  expect(state.decisions).toBe(0);
  await expect(page.getByRole("button", { name: "Pass ✓", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("direct unit photo and memo remain visible with no install round", async ({ page }) => {
  await evidenceFixtures(page, { emptyEvents: true, onlyDirect: true });
  await page.goto("/qc");
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  await expect(page.locator('img[src*="direct-only.jpg"]')).toBeVisible();
  await expect(page.locator('audio[src*="direct-only.wav"]')).toBeVisible();
  await expect(page.getByText("Direct recording transcript", { exact: true })).toBeVisible();
});

test("failed media reads are not called empty and can be retried", async ({ page }) => {
  const state = await evidenceFixtures(page);
  state.failFiles = true;
  await page.goto("/qc");
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  await expect(page.getByText("secret_media_table", { exact: false })).toHaveCount(0);
  await expect(page.getByText(/could not load|unavailable|couldn't load/i).first()).toBeVisible();
  state.failFiles = false;
  await page.getByRole("button", { name: /try again|retry|refresh/i }).first().click();
  await expect(page.locator('img[src*="qc-after.jpg"]')).toBeVisible();
  expect(state.decisions).toBe(0);
});

test("QC history opens current unit evidence and view switches stop its audio", async ({ page }) => {
  const state = await evidenceFixtures(page);
  await page.goto("/qc");
  await page.getByRole("button", { name: "Review history", exact: true }).click();
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  await expect(page.getByText("Showing the unit’s current information and saved files.", { exact: true })).toBeVisible();
  await expect(page.locator("audio")).toHaveCount(2);
  await page.getByRole("button", { name: "Needs review", exact: true }).click();
  await expect(page.locator("audio")).toHaveCount(0);
  expect(state.decisions).toBe(0);
});

test("an installer cannot fetch QC unit media", async ({ page }) => {
  const state = await evidenceFixtures(page, { role: "installer" });
  await page.goto("/qc");
  await expect(page.getByRole("button", { name: "View unit details", exact: true })).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(state.evidenceReads).toBe(0);
  expect(state.signedPaths).toEqual([]);
});

test("an unavailable original recording stays visible and refresh restores playback", async ({ page }) => {
  const state = await evidenceFixtures(page);
  state.failMemoSign = true;
  await page.goto("/qc");
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  await expect(page.getByText("Recording unavailable. Refresh the record or open the original file.", { exact: true })).toBeVisible();
  await expect(page.locator("audio")).toHaveCount(1);
  state.failMemoSign = false;
  await page.getByRole("button", { name: "Refresh record", exact: true }).click();
  await expect(page.locator("audio")).toHaveCount(2);
  const memo = page.locator('audio[src*="current-memo.wav"]');
  await memo.evaluate(async (node: HTMLAudioElement) => { await node.play(); node.pause(); });
  expect(state.decisions).toBe(0);
});

test("a verified empty record says no files and Escape returns focus", async ({ page }) => {
  await evidenceFixtures(page, { emptyEvents: true, emptyFiles: true });
  await page.goto("/qc");
  const opener = page.getByRole("button", { name: "View unit details", exact: true });
  await opener.click();
  await expect(page.getByText("No photos saved on this unit.", { exact: true })).toBeVisible();
  await expect(page.getByText("No voice memos saved on this unit.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close unit details", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Unit details", exact: true })).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("a photo rejected by the browser offers the original file and a retry", async ({ page }) => {
  await evidenceFixtures(page);
  await page.route("**/storage/v1/object/sign/install-media/**qc-after.jpg?*", route => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "image/jpeg", body: "broken-photo" });
    return route.fallback();
  });
  await page.goto("/qc");
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  const card = page.locator("figure").filter({ hasText: "Lower frame and sill" });
  await expect(card.getByText("Photo unavailable. Refresh the record to try again.", { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: "Open full-size photo", exact: true })).toHaveCount(1);
});

for (const kind of ["photo", "voice memo"] as const) {
  for (const sameUrl of [false, true]) {
    test(`refresh retries a failed ${kind} with ${sameUrl ? "the same" : "a new"} signed link`, async ({ page }) => {
      await evidenceFixtures(page);
      let signatures = 0;
      let freshReady = false;
      let releaseFresh!: () => void;
      const freshGate = new Promise<void>(resolve => { releaseFresh = resolve; });
      const filename = kind === "photo" ? "qc-after.jpg" : "current-memo.wav";
      await page.route(`**/storage/v1/object/sign/install-media/**${filename}**`, async route => {
        const url = new URL(route.request().url());
        const path = url.pathname.split("/object/sign/install-media/")[1];
        if (route.request().method() === "POST") {
          const version = ++signatures;
          if (version === 2) { await freshGate; freshReady = true; }
          return json(route, { signedURL: `/object/sign/install-media/${path}?token=version-${sameUrl ? 1 : version}` });
        }
        return route.fulfill({ status: 200, contentType: kind === "photo" ? "image/png" : "audio/wav",
          body: freshReady ? (kind === "photo" ? PNG : silentWav()) : Buffer.from("expired-media") });
      });
      await page.goto("/qc");
      await page.getByRole("button", { name: "View unit details", exact: true }).click();
      const card = kind === "photo" ? page.locator("figure").filter({ hasText: "Lower frame and sill" })
        : page.locator("figure").filter({ has: page.locator(`a[href*="${filename}"]`) });
      await card.scrollIntoViewIfNeeded();
      const unavailable = card.getByText(kind === "photo" ? "Photo unavailable. Refresh the record to try again."
        : "Recording unavailable. Refresh the record or open the original file.", { exact: true });
      await expect(unavailable).toBeVisible();
      await page.getByRole("button", { name: "Refresh record", exact: true }).click();
      await expect.poll(() => signatures).toBe(2);
      // Keep the failed view while the replacement link is still pending.
      await expect(unavailable).toBeVisible();
      releaseFresh();
      const media = card.locator(kind === "photo" ? "img" : "audio");
      await expect(media).toHaveAttribute("src", new RegExp(`token=version-${sameUrl ? 1 : 2}`));
      await card.scrollIntoViewIfNeeded();
      await expect(media).toBeVisible();
      if (kind === "photo") await expect.poll(() => media.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
      else await expect.poll(() => media.evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThanOrEqual(1);
      await expect(unavailable).toHaveCount(0);
    });
  }
}

for (const kind of ["photo", "voice memo"] as const) {
  test(`a delayed old ${kind} response cannot hide refreshed media`, async ({ page }) => {
    await evidenceFixtures(page);
    let signatures = 0;
    let oldStarted = false;
    let oldSettled = false;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const filename = kind === "photo" ? "qc-after.jpg" : "current-memo.wav";
    await page.route(`**/storage/v1/object/sign/install-media/**${filename}**`, async route => {
      const url = new URL(route.request().url());
      const path = url.pathname.split("/object/sign/install-media/")[1];
      if (route.request().method() === "POST") return json(route, { signedURL: `/object/sign/install-media/${path}?token=version-${++signatures}` });
      if (url.searchParams.get("token") === "version-1") {
        oldStarted = true;
        await oldGate;
        // Replacing the element may cancel this request before its error arrives.
        await route.fulfill({ status: 200, contentType: "application/octet-stream", body: "expired-media" }).catch(() => {});
        oldSettled = true;
        return;
      }
      return route.fulfill({ status: 200, contentType: kind === "photo" ? "image/png" : "audio/wav", body: kind === "photo" ? PNG : silentWav() });
    });
    await page.goto("/qc");
    await page.getByRole("button", { name: "View unit details", exact: true }).click();
    const card = kind === "photo" ? page.locator("figure").filter({ hasText: "Lower frame and sill" })
      : page.locator("figure").filter({ has: page.locator(`a[href*="${filename}"]`) });
    await card.scrollIntoViewIfNeeded();
    await expect.poll(() => oldStarted).toBe(true);
    await page.getByRole("button", { name: "Refresh record", exact: true }).click();
    const media = card.locator(kind === "photo" ? "img" : "audio");
    await expect(media).toHaveAttribute("src", /token=version-2/);
    await card.scrollIntoViewIfNeeded();
    await expect.poll(() => media.evaluate((node: HTMLImageElement | HTMLAudioElement) => node instanceof HTMLImageElement ? node.naturalWidth : node.readyState)).toBeGreaterThan(0);
    releaseOld();
    await expect.poll(() => oldSettled).toBe(true);
    await expect(media).toBeVisible();
    await expect(card.getByRole("status")).toHaveCount(0);
  });
}

test("a failed refresh preserves the unavailable photo and explains the stale record", async ({ page }) => {
  await evidenceFixtures(page);
  let failOpening = false;
  await page.route("**/rest/v1/project_openings**", route => {
    if (failOpening && new URL(route.request().url()).searchParams.get("id") === `eq.${OPENING_ID}`) {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "private opening failure" }) });
    }
    return route.fallback();
  });
  await page.route("**/storage/v1/object/sign/install-media/**qc-after.jpg?*", route => {
    if (route.request().method() === "GET") return route.fulfill({ status: 200, contentType: "image/jpeg", body: "expired-photo" });
    return route.fallback();
  });
  await page.goto("/qc");
  await page.getByRole("button", { name: "View unit details", exact: true }).click();
  const card = page.locator("figure").filter({ hasText: "Lower frame and sill" });
  await expect(card.getByRole("status")).toBeVisible();
  failOpening = true;
  await page.getByRole("button", { name: "Refresh record", exact: true }).click();
  await expect(page.getByRole("region", { name: "Unit details", exact: true }).getByRole("alert")).toBeVisible();
  await expect(card.getByText("Photo unavailable. Refresh the record to try again.", { exact: true })).toBeVisible();
  await expect(page.getByText("private opening failure")).toHaveCount(0);
});



test("switching same-code units does not retain the previous job's media", async ({ page }) => {
  const state = await evidenceFixtures(page, { twoUnits: true });
  await page.goto("/qc");
  await page.getByRole("button", { name: "View unit details", exact: true }).first().click();
  await expect(page.locator("audio")).toHaveCount(2);
  state.signedPaths.length = 0;
  await page.getByRole("button", { name: "View unit details", exact: true }).last().click();
  await expect(page.locator('img[src*="second-unit.jpg"]')).toBeVisible();
  await expect(page.locator("audio")).toHaveCount(0);
  await expect(page.locator('img[src*="qc-after.jpg"]')).toHaveCount(0);
  await expect(page.getByText("Frame seated squarely", { exact: true })).toHaveCount(0);
  expect(state.signedPaths.some(path => path.includes("current-memo") || path.includes("qc-after"))).toBe(false);
  expect(state.decisions).toBe(0);
});

for (const variant of [
  { width: 375, language: "es" as const, button: "Ver detalles de la unidad" },
  { width: 1280, language: "en" as const, button: "View unit details" },
]) {
  test(`QC evidence fits ${variant.language} at ${variant.width}px and is keyboard reachable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: variant.width, height: 844 });
    if (variant.language === "es") await page.emulateMedia({ colorScheme: "dark" });
    await evidenceFixtures(page, { language: variant.language });
    await page.goto("/qc");
    const button = page.getByRole("button", { name: variant.button, exact: true });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('img[src*="unit-detail.jpg"]')).toBeVisible();
    await expect(page.locator("audio")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`qc-evidence-${variant.width}-${variant.language}.png`), fullPage: true });
  });
}

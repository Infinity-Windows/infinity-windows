// Learn → Using Forge in a real browser: phone widths 320 and 390 and a
// desktop, English and Spanish, with the catalog and storage replayed from
// fixtures. The video is a synthetic test pattern encoded at run time by
// Playwright's own ffmpeg — no walkthrough footage is, or ever should be, in
// this repository.
import { expect, test, type Page, type Route } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const PREVIEW_EN = "Design preview — some steps are proposed, not available in the current app.";
const PREVIEW_ES = "Vista previa de diseño — algunos pasos son propuestas y no están disponibles en la app actual.";
const DURATION = 30;

function row(slug: "installer" | "foreman" | "leadership") {
  return {
    id: `fixture-${slug}`,
    slug,
    title: { installer: "Installer day", foreman: "Foreman day", leadership: "Owner and supervisor day" }[slug],
    min_role: slug === "leadership" ? "supervisor" : slug,
    language: "en",
    content_status: "proposal",
    version: 1,
    duration_seconds: DURATION,
    video_path: `${slug}/en/v1/walkthrough.mp4`,
    captions_path: `${slug}/en/v1/captions.vtt`,
    poster_path: null,
    transcript_text: "Open Forge and clock in.\n\nThe proposed job card comes next.",
    chapters: [
      { seconds: 0, title: "Clock in", status: "live" },
      { seconds: 10, title: "Proposed job card", status: "proposal" },
      { seconds: 20, title: "Toolbox talk", status: "mixed" },
    ],
    published_at: "2026-09-23T12:00:00Z",
    active: true,
  };
}

const VTT = [
  "WEBVTT",
  "",
  "00:00.000 --> 00:09.500",
  "Open Forge and clock in.",
  "",
  "00:20.000 --> 00:29.500",
  "Sign the toolbox talk.",
  "",
].join("\n");

/** Playwright's bundled ffmpeg (it records test videos with it). */
function findFfmpeg(): string | null {
  if (process.env.PLAYWRIGHT_FFMPEG && existsSync(process.env.PLAYWRIGHT_FFMPEG)) return process.env.PLAYWRIGHT_FFMPEG;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => d.startsWith("ffmpeg"))) {
      for (const bin of ["ffmpeg-mac", "ffmpeg-linux", "ffmpeg-win64.exe"]) {
        const p = join(root, dir, bin);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const testVideos = new Map<string, Buffer>();

/**
 * A seekable WebM test pattern of the given size: frames drawn on a canvas in
 * the browser, piped as JPEG into ffmpeg exactly the way Playwright records
 * its own test videos. Fails the test, rather than skipping it, when there is
 * no ffmpeg — a player test that quietly does not run proves nothing. Set
 * PLAYWRIGHT_FFMPEG to point at any ffmpeg with the mjpeg decoder and vp8.
 */
async function makeTestVideo(page: Page, width = 320, height = 180): Promise<Buffer> {
  const key = `${width}x${height}`;
  const cached = testVideos.get(key);
  if (cached) return cached;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("No ffmpeg: install Playwright's (npx playwright install ffmpeg) or set PLAYWRIGHT_FFMPEG.");
  await page.goto("about:blank");
  const frames: string[] = await page.evaluate(
    ({ duration, width, height }) => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const g = c.getContext("2d")!;
      const out: string[] = [];
      for (let i = 0; i < duration * 2; i++) {
        g.fillStyle = `hsl(${(i * 12) % 360} 55% 35%)`;
        g.fillRect(0, 0, width, height);
        g.fillStyle = "#fff";
        g.font = "bold 48px sans-serif";
        g.fillText(`${Math.floor(i / 2)}s`, width / 2 - 40, height / 2 + 16);
        out.push(c.toDataURL("image/jpeg", 0.7).split(",")[1]);
      }
      return out;
    },
    { duration: DURATION, width, height },
  );
  const out = join(mkdtempSync(join(tmpdir(), "uf-e2e-")), `pattern-${key}.webm`);
  const r = spawnSync(
    ffmpeg,
    ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "2", "-c:v", "mjpeg", "-i", "pipe:0", "-c:v", "vp8", "-b:v", "150k", out],
    { input: Buffer.concat(frames.map((f) => Buffer.from(f, "base64"))) },
  );
  if (r.status !== 0 || !existsSync(out)) throw new Error(`ffmpeg could not encode the test pattern: ${String(r.stderr).slice(0, 300)}`);
  const video = readFileSync(out);
  testVideos.set(key, video);
  return video;
}

/** Serve bytes with Range support, the way storage does for media. */
function serveMedia(route: Route, body: Buffer, contentType: string) {
  const range = route.request().headers()["range"];
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) {
    return route.fulfill({ status: 200, body, headers: { "content-type": contentType, "accept-ranges": "bytes" } });
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
  return route.fulfill({
    status: 206,
    body: body.subarray(start, end + 1),
    headers: {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${body.length}`,
    },
  });
}

async function walkthroughFixtures(
  page: Page,
  opts: { rows: unknown[]; video: Buffer | null; signFails?: () => boolean; catalogStatus?: number },
) {
  await page.route("**/rest/v1/app_training_videos*", (route) =>
    opts.catalogStatus
      ? route.fulfill({ status: opts.catalogStatus, json: { code: "PGRST205", message: "Could not find the table 'public.app_training_videos'" } })
      : route.fulfill({ json: opts.rows }),
  );
  // Registered after the generic storage fixture, so these win.
  await page.route("**/storage/v1/object/sign/app-training", async (route) => {
    if (opts.signFails?.()) return route.fulfill({ status: 503, json: { message: "unavailable" } });
    const { paths } = route.request().postDataJSON() as { paths: string[] };
    return route.fulfill({
      json: paths.map((path) => ({ path, error: null, signedURL: `/object/sign/app-training/${path}?token=fixture` })),
    });
  });
  await page.route("**/storage/v1/object/sign/app-training/**", (route) => {
    const url = route.request().url();
    if (url.includes("captions.vtt")) return route.fulfill({ body: VTT, contentType: "text/vtt" });
    if (url.includes("walkthrough.mp4") && opts.video) return serveMedia(route, opts.video, "video/webm");
    return route.fulfill({ status: 404, body: "not found" });
  });
}

async function openTab(page: Page, label: string) {
  await page.goto("/learn");
  await page.locator(".hub-tab", { hasText: label }).click();
}

const noSideScroll = (page: Page) =>
  expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

test("installer on a 320px phone: one walkthrough, warning first, chapter seeking and captions", async ({ page }) => {
  const video = await makeTestVideo(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await useSupabaseFixtures(page, { role: "installer" });
  await walkthroughFixtures(page, { rows: [row("installer"), row("foreman"), row("leadership")], video });
  await openTab(page, "Using Forge");

  const cards = page.locator(".uf-card");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(PREVIEW_EN);
  await expect(cards.first()).toContainText("Installers and up");
  await expect(page.getByText("Owner and supervisor day")).toHaveCount(0);
  await noSideScroll(page);
  await page.screenshot({ path: "e2e/test-results/using-forge-320-list.png", fullPage: true, style: ".pwa-banner-wrong-project { visibility: hidden; }" });

  await page.getByRole("button", { name: "Watch Installer day" }).click();
  const player = page.locator(".uf-player");
  const el = player.locator("video");
  await expect(player.locator(".uf-preview")).toContainText(PREVIEW_EN);
  await expect(el).toBeVisible();
  expect(await el.evaluate((v: HTMLVideoElement) => ({ autoplay: v.autoplay, inline: v.playsInline, controls: v.controls }))).toEqual({
    autoplay: false,
    inline: true,
    controls: true,
  });
  await expect.poll(() => el.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await el.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

  // Captions: an English track, showing by default, with its cues loaded.
  await expect
    .poll(() => el.evaluate((v: HTMLVideoElement) => ({ mode: v.textTracks[0]?.mode, lang: v.textTracks[0]?.language, cues: v.textTracks[0]?.cues?.length ?? 0 })))
    .toEqual({ mode: "showing", lang: "en", cues: 2 });

  // Seek from the chapter list; the chapter highlights, the playhead moves,
  // the caption for that moment is the active one, and nothing autoplays.
  const chapter = page.getByRole("button", { name: "Jump to 0:20, Toolbox talk" });
  await chapter.click();
  await expect(chapter).toHaveAttribute("aria-current", "true");
  await expect.poll(() => el.evaluate((v: HTMLVideoElement) => Math.round(v.currentTime))).toBe(20);
  await expect
    .poll(() => el.evaluate((v: HTMLVideoElement) => (v.textTracks[0].activeCues?.[0] as VTTCue | undefined)?.text ?? null))
    .toBe("Sign the toolbox talk.");
  expect(await el.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await expect(chapter).toContainText("Partly in the app");

  await player.getByText("Read the transcript").click();
  await expect(player.getByText("The proposed job card comes next.")).toBeVisible();
  await noSideScroll(page);
  await page.screenshot({ path: "e2e/test-results/using-forge-320-player.png", fullPage: true, style: ".pwa-banner-wrong-project { visibility: hidden; }" });
});

test("foreman on a 390px phone in Spanish: two walkthroughs, English narration stated truthfully", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useSupabaseFixtures(page, { role: "foreman", language: "es" });
  await walkthroughFixtures(page, { rows: [row("installer"), row("foreman")], video: null });
  await openTab(page, "Usar Forge");
  const cards = page.locator(".uf-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText(PREVIEW_ES);
  await expect(cards.nth(1)).toContainText("Capataces y superiores");
  await expect(cards.first()).toContainText("Narración y subtítulos en inglés");
  await noSideScroll(page);
  await page.screenshot({ path: "e2e/test-results/using-forge-390-es.png", fullPage: true, style: ".pwa-banner-wrong-project { visibility: hidden; }" });
});

test("owner on desktop sees all three; previewing installer narrows to one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await useSupabaseFixtures(page, { role: "owner" });
  await walkthroughFixtures(page, { rows: [row("installer"), row("foreman"), row("leadership")], video: null });
  await openTab(page, "Using Forge");
  await expect(page.locator(".uf-card")).toHaveCount(3);
  await expect(page.locator(".uf-card .uf-preview")).toHaveCount(3);
  await page.screenshot({ path: "e2e/test-results/using-forge-desktop.png", fullPage: true, style: ".pwa-banner-wrong-project { visibility: hidden; }" });

  await page.evaluate(() => sessionStorage.setItem("infinity.viewAsRole", "installer"));
  await openTab(page, "Using Forge");
  await expect(page.locator(".uf-card")).toHaveCount(1);
  await expect(page.getByText("Owner and supervisor day")).toHaveCount(0);
  await expect(page.locator(".training-importer")).toHaveCount(0);
});

test("a missing catalog is an honest empty shelf, and a failed signature offers Retry", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await walkthroughFixtures(page, { rows: [], video: null, catalogStatus: 404 });
  await openTab(page, "Using Forge");
  await expect(page.getByText("No walkthroughs yet")).toBeVisible();
  await expect(page.locator("video")).toHaveCount(0);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  let fail = true;
  await useSupabaseFixtures(page, { role: "installer" });
  await walkthroughFixtures(page, { rows: [row("installer")], video: null, signFails: () => fail });
  await openTab(page, "Using Forge");
  await page.getByRole("button", { name: "Watch Installer day" }).click();
  await expect(page.getByText("The video couldn't be opened.")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".uf-player video")).toHaveCount(1);
});

test("a portrait phone recording fills a 390px phone at its own shape, not squashed into 16:9", async ({ page }) => {
  // 360×640 (9:16), the shape a walkthrough recorded on a phone arrives in.
  const video = await makeTestVideo(page, 360, 640);
  await page.setViewportSize({ width: 390, height: 844 });
  await useSupabaseFixtures(page, { role: "installer" });
  await walkthroughFixtures(page, { rows: [row("installer")], video });
  await openTab(page, "Using Forge");
  await page.getByRole("button", { name: "Watch Installer day" }).click();
  const el = page.locator(".uf-player video");
  await expect.poll(() => el.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await el.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])).toEqual([360, 640]);

  const box = (await el.boundingBox())!;
  const viewport = page.viewportSize()!;
  // Full width of the column, and TALL: the element takes the recording's own
  // shape, capped at 78% of the screen height, never a letterboxed 16:9 strip.
  expect(box.width).toBeGreaterThan(300);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.height).toBeGreaterThan(box.width * 1.5);
  expect(box.height).toBeLessThanOrEqual(viewport.height * 0.78 + 1);
  const expectedHeight = Math.min((box.width * 640) / 360, viewport.height * 0.78);
  expect(Math.abs(box.height - expectedHeight)).toBeLessThan(4);
  // The chapters still follow the video rather than sitting under it.
  const chapters = (await page.locator(".uf-chapters").boundingBox())!;
  expect(chapters.y).toBeGreaterThanOrEqual(box.y + box.height);
  await noSideScroll(page);
  await page.screenshot({ path: "e2e/test-results/using-forge-390-portrait.png", fullPage: true, style: ".pwa-banner-wrong-project { visibility: hidden; }" });
});

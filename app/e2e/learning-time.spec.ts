// Learning time, end to end with mocked routes. House style: real UI, mocked
// network, and every assertion is about what a tap actually SENT rather than
// about something having rendered.
//
// Three things are worth an e2e here, and they are the three the unit tests
// cannot reach:
//   - the beat is really wired to the browser's own idea of visible. The
//     cadence and the gating rules are unit-tested with fake timers
//     (src/lib/learningTime.test.ts); what only a browser can prove is that
//     hiding the document actually stops it and showing it starts it again.
//   - the owner's page renders a person's rows out of the two report RPCs.
//   - the lesson player asks YouTube for the IFrame API (enablejsapi=1 in the
//     iframe's own src) and reports a position when the player says it is
//     playing. window.YT is stubbed, so no third-party script is fetched.

import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/learning-time");
mkdirSync(SHOTS, { recursive: true });

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

const VIDEO_ID = "22222222-2222-4222-8222-222222222222";
const PERSON_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERSON_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** Catch every learning_heartbeat the page sends, and answer it. */
async function catchHeartbeats(page: Page): Promise<Record<string, unknown>[]> {
  const beats: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/learning_heartbeat", (route) => {
    beats.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, null, 1);
  });
  return beats;
}

/** Everything else the Learn page reads, answered with nothing to show. */
async function useLearnRoutes(page: Page) {
  for (const path of [
    "**/rest/v1/learn_progress**",
    "**/rest/v1/learn_priority_terms**",
    "**/rest/v1/learning_videos**",
    "**/rest/v1/learning_time**",
    "**/rest/v1/learning_video_watches**",
  ]) {
    await page.route(path, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return json(route, [], 0);
    });
  }
}

test("Learn beats while the page is visible, and stops the moment it is hidden", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useLearnRoutes(page);
  const beats = await catchHeartbeats(page);

  await page.goto("/learn");
  await expect(page.getByRole("heading", { name: "Learn" })).toBeVisible();

  // Opening the page opens a row for the tab it landed on.
  await expect.poll(() => beats.length).toBeGreaterThan(0);
  const first = beats.find((b) => b.p_item_kind === "tab");
  expect(first, "the Learn page reports time against the open tab").toBeTruthy();
  expect(first!.p_item_key).toBe("daily");
  // The visit id is the page's, minted once — never supplied per beat by hand.
  expect(String(first!.p_session_id)).toMatch(/^[0-9a-f-]{36}$/);
  // And the phone never claims a duration on the opening beat.
  expect(first!.p_seconds).toBe(0);

  // Now hide the document, the way a locked phone or a backgrounded PWA does.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const beforeHidden = beats.length;
  await page.getByRole("button", { name: "Glossary" }).click();
  await expect(page.locator("select").first()).toBeVisible();
  // Opening a whole tab behind a locked phone banks nothing at all.
  await page.waitForTimeout(1500);
  expect(beats.length, "nothing is sent while the screen is hidden").toBe(beforeHidden);

  // Back in front of somebody, and it picks up again.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.getByRole("button", { name: "Sequence" }).click();
  await expect.poll(() => beats.length).toBeGreaterThan(beforeHidden);
  const resumed = beats.slice(beforeHidden);
  expect(resumed.some((b) => b.p_item_kind === "tab" && b.p_item_key === "sequence")).toBe(
    true,
  );
  // The Sequence tab IS its round, so it is named as one too.
  expect(resumed.some((b) => b.p_item_kind === "sequence")).toBe(true);
});

test("the bottom of Learn tells a crew member what is being recorded about them", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useLearnRoutes(page);
  await catchHeartbeats(page);

  await page.route("**/rest/v1/learning_time**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, [{ active_seconds: 7800 }], 1);
  });
  await page.route("**/rest/v1/learning_video_watches**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, [{ video_id: "v1" }, { video_id: "v2" }, { video_id: "v3" }], 3);
  });

  await page.goto("/learn");
  await expect(page.getByText("Your learning time:")).toBeVisible();
  await expect(page.getByText("2h 10m this week")).toBeVisible();
  await expect(page.getByText("3 lessons finished")).toBeVisible();
  await expect(
    page.getByText("It only counts while this screen is in front of you", {
      exact: false,
    }),
  ).toBeVisible();

  // All the way to the end of the page, not merely far enough to be visible:
  // .app-main carries the clearance that keeps the last thing on a page out
  // from under the bottom bar and the floating Ask button, and that clearance
  // only does its job at the bottom of the scroll.
  await page.evaluate(() => {
    const el = document.querySelector(".app-main") ?? document.scrollingElement;
    if (el) el.scrollTop = el.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
  await expect(page.getByText("Your learning time:")).toBeInViewport();
  await page.screenshot({ path: join(SHOTS, "learn-footer-390.png") });
});

test("the owner's page draws a person's learning out of the two report calls", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });

  await page.route("**/rest/v1/rpc/learning_time_report", (route) =>
    json(
      route,
      [
        {
          profile_id: PERSON_A,
          display_name: "Crew A",
          item_kind: "tab",
          item_key: "glossary",
          active_seconds: 7800,
          visits: 4,
          last_seen_at: "2026-09-04T18:00:00Z",
        },
        {
          profile_id: PERSON_A,
          display_name: "Crew A",
          item_kind: "term",
          item_key: "sillpan",
          active_seconds: 900,
          visits: 3,
          last_seen_at: "2026-09-04T18:00:00Z",
        },
        {
          profile_id: PERSON_B,
          display_name: "Crew B",
          item_kind: "tab",
          item_key: "quiz",
          active_seconds: 600,
          visits: 1,
          last_seen_at: "2026-09-02T18:00:00Z",
        },
      ],
      3,
    ),
  );
  await page.route("**/rest/v1/rpc/learning_video_report", (route) =>
    json(
      route,
      [
        {
          profile_id: PERSON_A,
          display_name: "Crew A",
          video_id: VIDEO_ID,
          video_title: "Flashing a head",
          times_watched: 3,
          best_seconds: 180,
          union_seconds: 190,
          duration_seconds: 200,
          completed: true,
          last_watched_at: "2026-09-04T17:00:00Z",
        },
      ],
      1,
    ),
  );

  await page.goto("/learning/time");
  await expect(page.getByRole("heading", { name: "Learning time" })).toBeVisible();

  // Most time first: the 2h 10m person is above the 10m one, and the sort is
  // by TIME rather than by the order the rows came back in.
  const cards = page.locator(".project-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Crew A");
  await expect(cards.nth(0)).toContainText("2h 10m");
  await expect(cards.nth(1)).toContainText("Crew B");
  await expect(cards.nth(1)).toContainText("10m");

  // The breakdown is shown as part of the total, and says so. 15m of glossary
  // terms sits INSIDE the 2h 10m, never beside it.
  await expect(cards.nth(0)).toContainText("Glossary terms");
  await expect(cards.nth(0)).toContainText("15m");
  await expect(
    page.getByText("These are part of the total above, not extra time on top of it."),
  ).toBeVisible();

  // "AND ON WHAT ITEM" — the second half of the owner's ask. The chip says how
  // long on glossary terms; this says WHICH term, by the glossary's own name
  // for it rather than by the id the row carries.
  await expect(cards.nth(0)).toContainText("What they were on");
  await expect(cards.nth(0)).toContainText("Sill Pan");
  await expect(cards.nth(0)).toContainText("3 visits");

  // The lesson line: how many times, how much of it, and finished — with the
  // percentage beside the verdict, never instead of it.
  await expect(page.getByText("Flashing a head")).toBeVisible();
  await expect(page.getByText("watched 3×", { exact: false })).toBeVisible();
  await expect(page.getByText("95% watched", { exact: false })).toBeVisible();
  await expect(page.getByText("best sitting 90%", { exact: false })).toBeVisible();
  await expect(page.locator("span.ok", { hasText: "Finished" })).toBeVisible();
  await expect(
    page.getByText("A watch is one visit that got through at least 30 seconds.", {
      exact: false,
    }),
  ).toBeVisible();

  await page.setViewportSize({ width: 1200, height: 900 });
  await page.screenshot({ path: join(SHOTS, "owner-1200-light.png"), fullPage: true });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Learning time" })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "owner-390-dark.png"), fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
});

test("a lesson mounts the real YouTube player and reports where the play head is", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useLearnRoutes(page);
  await catchHeartbeats(page);

  // The API, stubbed before anything loads. loadYouTubeIframeApi() finds
  // window.YT already there and never fetches youtube.com — an e2e must not
  // reach a third party, and the point being proved is our wiring, not theirs.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__ytPosition = 0;
    w.YT = {
      Player: function (this: Record<string, unknown>, _el: unknown, opts: unknown) {
        w.__ytEvents = (opts as { events?: unknown }).events;
        this.getCurrentTime = () => Number(w.__ytPosition ?? 0);
        this.getDuration = () => 200;
        this.destroy = () => {};
        return this;
      },
    };
  });

  const watches: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/learning_video_heartbeat", (route) => {
    watches.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, null, 1);
  });
  await page.route("**/rest/v1/learning_videos**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(
      route,
      [
        {
          id: VIDEO_ID,
          title: "Flashing a head",
          window_type_id: null,
          topic: "Flashing",
          video_path: null,
          youtube_url: "https://youtu.be/dQw4w9WgXcQ",
          summary: null,
          transcript: null,
          active: true,
          created_by: "e2e",
          created_at: "2026-09-01T00:00:00Z",
          updated_at: "2026-09-01T00:00:00Z",
          grants_clearance: null,
          status: "published",
        },
      ],
      1,
    );
  });
  await page.route("**/rest/v1/rpc/list_video_quiz", (route) => json(route, null, 1));

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();
  await expect(page.getByText("Flashing a head")).toBeVisible();

  // The embed itself carries the switch that makes watching measurable.
  const src = await page.locator("iframe.learn-video-frame").first().getAttribute("src");
  expect(src).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
  expect(src).toContain("enablejsapi=1");
  expect(src).toContain("playsinline=1");
  expect(src).toContain("origin=");

  // Press play, thirty seconds in.
  await expect
    .poll(() => page.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__ytEvents)))
    .toBe(true);
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__ytPosition = 30;
    (w.__ytEvents as { onStateChange: (e: { data: number }) => void }).onStateChange({
      data: 1,
    });
  });

  await expect.poll(() => watches.length).toBeGreaterThan(0);
  expect(watches[0].p_video_id).toBe(VIDEO_ID);
  expect(watches[0].p_position_s).toBe(30);
  expect(watches[0].p_duration_s).toBe(200);
  expect(watches[0].p_playing).toBe(true);

  // And the end: the position is the duration and the player is not playing,
  // which is the one shape the server reads as finished.
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__ytPosition = 200;
    (w.__ytEvents as { onStateChange: (e: { data: number }) => void }).onStateChange({
      data: 0,
    });
  });
  await expect.poll(() => watches.length).toBeGreaterThan(1);
  const last = watches[watches.length - 1];
  expect(last.p_position_s).toBe(200);
  expect(last.p_duration_s).toBe(200);
  expect(last.p_playing).toBe(false);
});

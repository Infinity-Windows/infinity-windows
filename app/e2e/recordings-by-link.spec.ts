// Wave U: recordings by link, end to end with mocked routes. Same house style
// as video-quizzes.spec.ts — mocked routes, real UI, assert the thing a tap
// actually produces rather than that something rendered.
//
// The wave's own acceptance list:
//   - a draft is invisible to an installer
//   - a draft is in the supervisor's Inbox, and Publish moves it into the library
//   - "Send a recording" builds a mailto: addressed to the leads on the job
//     the installer is clocked into, with the job and the day in the subject
//   - a YouTube-linked lesson shows no Transcribe button (uploads still do)
import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

const VIDEO_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

interface VideoRow extends Record<string, unknown> {
  id: string;
  title: string;
  status: string;
}

function video(over: Partial<VideoRow> & { id: string; title: string }): VideoRow {
  return {
    window_type_id: null,
    topic: "Corner units",
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
    ...over,
  };
}

/** Every route this spec touches, registered AFTER useSupabaseFixtures so
 * these win over the shared router's generic defaults. `state` is mutated by
 * the RPC handlers so a re-read after a tap sees what the tap wrote. */
async function useRecordingRoutes(
  page: Page,
  opts: {
    videos: VideoRow[];
    contacts?: { display_name: string; email: string }[];
    /** The open shift the "Send a recording" subject names, if any. */
    shift?: Record<string, unknown> | null;
    onPublish?: (body: Record<string, unknown>) => void;
  },
) {
  const state = { videos: opts.videos };

  await page.route("**/rest/v1/learning_videos**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, state.videos, state.videos.length);
  });

  await page.route("**/rest/v1/learning_video_quizzes**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, null, 0);
  });

  await page.route("**/rest/v1/rpc/list_video_quiz", (route) => json(route, null, 1));

  await page.route("**/rest/v1/rpc/publish_learning_video", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    opts.onPublish?.(body);
    state.videos = state.videos.map((v) =>
      v.id === body.p_id ? { ...v, status: "published" } : v,
    );
    return json(route, state.videos.find((v) => v.id === body.p_id) ?? null, 1);
  });

  await page.route("**/rest/v1/rpc/foreman_contacts_for_me", (route) =>
    json(route, opts.contacts ?? [], (opts.contacts ?? []).length),
  );

  await page.route("**/rest/v1/time_shifts**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const single = (route.request().headers()["accept"] ?? "").includes("pgrst.object");
    const shift = opts.shift ?? null;
    if (single) return json(route, shift, shift ? 1 : 0);
    return json(route, shift ? [shift] : [], shift ? 1 : 0);
  });
}

const OPEN_SHIFT = {
  id: "44444444-4444-4444-8444-444444444444",
  profile_id: "00000000-0000-4000-8000-0000000000e2",
  project_id: PROJECT_ID,
  cost_code_id: null,
  clock_in_at: "2026-09-03T13:00:00Z",
  clock_out_at: null,
  break_seconds: 0,
  break_started_at: null,
  injured: false,
  time_confirmed: false,
  status: "open",
  created_at: "2026-09-03T13:00:00Z",
  projects: { job_code: "BLACK22", name: "Black Desert" },
  cost_codes: null,
  profiles: { display_name: "E2E Fixture" },
};

test("an installer never sees a draft lesson — no card, no Inbox", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useRecordingRoutes(page, {
    videos: [
      video({ id: VIDEO_ID, title: "Installing the corner unit", status: "draft" }),
      video({ id: "published-1", title: "Flashing a head", status: "published" }),
    ],
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();

  await expect(page.getByText("Flashing a head")).toBeVisible();
  await expect(page.getByText("Installing the corner unit")).toHaveCount(0);
  await expect(page.getByText("Inbox — not published yet")).toHaveCount(0);
});

test("a supervisor's draft waits in the Inbox, and Publish moves it into the library", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const published: Record<string, unknown>[] = [];
  await useRecordingRoutes(page, {
    videos: [video({ id: VIDEO_ID, title: "Installing the corner unit", status: "draft" })],
    onPublish: (b) => published.push(b),
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();

  await expect(page.getByText("Inbox — not published yet")).toBeVisible();
  await expect(
    page.getByText("Only supervisors see these. Publish one once the lesson is ready for crews."),
  ).toBeVisible();
  await expect(page.getByText("Installing the corner unit")).toBeVisible();

  await page.getByRole("button", { name: "Publish", exact: true }).click();

  await expect.poll(() => published.length).toBe(1);
  expect(published[0].p_id).toBe(VIDEO_ID);
  // The re-read answers 'published', so the Inbox empties and the lesson is
  // simply in the library now.
  await expect(page.getByText("Inbox — not published yet")).toHaveCount(0);
  await expect(page.getByText("Installing the corner unit")).toBeVisible();
});

test("Send a recording addresses the leads on the job the installer is clocked into", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useRecordingRoutes(page, {
    videos: [],
    shift: OPEN_SHIFT,
    contacts: [
      { display_name: "Jed", email: "jed@forgewd.com" },
      { display_name: "Sam", email: "sam@forgewd.com" },
    ],
  });

  await page.goto("/learn");
  const link = page.getByTestId("send-recording");
  await expect(link).toBeVisible();
  await expect(link).toHaveText(/Send a recording/);

  await expect
    .poll(async () => (await link.getAttribute("href"))?.startsWith("mailto:jed@forgewd.com,sam@forgewd.com?"))
    .toBe(true);
  const href = (await link.getAttribute("href")) ?? "";
  const url = new URL(href);
  const params = new URLSearchParams(url.search);
  expect(params.get("subject")).toContain("Recording — Black Desert — ");
  expect(params.get("subject")).toContain(String(new Date().getFullYear()));
  expect(params.get("body")).toBe("Attach your video.");
  await expect(
    page.getByText("Email the video to your lead. They put it on YouTube and it shows up in Learn."),
  ).toBeVisible();
});

test("Send a recording still opens the composer with nobody to address", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useRecordingRoutes(page, { videos: [], shift: null, contacts: [] });

  await page.goto("/learn");
  const link = page.getByTestId("send-recording");
  await expect(link).toHaveAttribute("href", /^mailto:\?subject=Recording%20/);
  await expect(page.getByText("No lead's address on file — pick one in your mail app.")).toBeVisible();
});

test("Send a recording is on the job screen too", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useRecordingRoutes(page, {
    videos: [],
    shift: OPEN_SHIFT,
    contacts: [{ display_name: "Jed", email: "jed@forgewd.com" }],
  });

  await page.goto("/my-work");
  await expect(page.getByTestId("send-recording")).toBeVisible();
});

test("a linked lesson offers no Transcribe button; an uploaded one does", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useRecordingRoutes(page, {
    videos: [
      video({ id: VIDEO_ID, title: "Installing the corner unit", status: "published" }),
    ],
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();
  await page.getByRole("button", { name: "✎ Edit" }).click();

  // YouTube hands a server no captions, so the button that cannot work is not
  // drawn. The transcript is pasted instead, and the form says so.
  await expect(page.getByRole("button", { name: "Transcribe" })).toHaveCount(0);
  await expect(
    page.getByText(
      "YouTube won't hand us the words for a link. Paste the transcript here, or ask your coordinator to pull it for you.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate summary & quiz" })).toBeVisible();
});

test("an uploaded lesson still offers Transcribe — the small direct upload door stays open", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useRecordingRoutes(page, {
    videos: [
      video({
        id: VIDEO_ID,
        title: "Installing the corner unit",
        status: "published",
        youtube_url: null,
        video_path: "lesson.mp4",
      }),
    ],
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();
  await page.getByRole("button", { name: "✎ Edit" }).click();

  await expect(page.getByRole("button", { name: "Transcribe" })).toBeVisible();
});

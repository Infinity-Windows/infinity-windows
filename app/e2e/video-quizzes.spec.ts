// Wave Q: video summaries and quizzes, end to end with mocked routes. Same
// house style as receipts.spec.ts / daily-logs.spec.ts — mocked routes, real
// UI, assert the CAPTURED RPC PAYLOAD a tap actually sends, not just that
// something rendered.
//
// Covers the spec's own e2e list: add link + paste transcript -> Generate
// (mock the edge function) -> draft visible to supervisor, hidden from
// installer -> Approve -> installer takes the quiz (mock RPC) -> pass shows
// a points toast; fail path allows retake.
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

const VIDEO_ID = "11111111-1111-4111-8111-111111111111";

const FULL_QUESTIONS = Array.from({ length: 5 }, (_, i) => ({
  q: `Question ${i + 1}?`,
  choices: [`${i}a`, `${i}b`, `${i}c`, `${i}d`],
  correct_idx: 0,
  why: `Because ${i}a is right.`,
}));

const PUBLIC_QUESTIONS = FULL_QUESTIONS.map((q) => ({ q: q.q, choices: q.choices }));

/** Every video-quiz route this whole spec touches, registered AFTER
 * useSupabaseFixtures so these win over the shared fixture router's
 * generic defaults (the receipts.spec.ts idiom). `state` is mutated by the
 * RPC handlers so a GET made later in the same test sees what an earlier
 * mutation wrote — the same "the office table reads back what was just
 * filed" shape daily-logs.spec.ts's own mocks use. */
async function useVideoQuizRoutes(
  page: Page,
  opts: {
    video: Record<string, unknown> | null;
    quiz?: Record<string, unknown> | null;
    onSaveVideo?: (body: Record<string, unknown>) => void;
    onSaveDraft?: (body: Record<string, unknown>) => void;
    onApprove?: (body: Record<string, unknown>) => void;
    onSubmit?: (body: Record<string, unknown>) => void;
    submitResponse?: Record<string, unknown>;
    listQuizResponse?: unknown;
  },
) {
  const state = { video: opts.video, quiz: opts.quiz ?? null };

  await page.route("**/rest/v1/learning_videos**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, state.video ? [state.video] : [], state.video ? 1 : 0);
  });

  await page.route("**/rest/v1/learning_video_quizzes**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, state.quiz, state.quiz ? 1 : 0);
  });

  await page.route("**/rest/v1/rpc/save_learning_video", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    opts.onSaveVideo?.(body);
    state.video = {
      id: VIDEO_ID,
      title: body.p_title,
      window_type_id: body.p_window_type ?? null,
      topic: body.p_topic ?? null,
      video_path: body.p_video_path ?? null,
      youtube_url: body.p_youtube_url ?? null,
      summary: body.p_summary ?? null,
      transcript: body.p_transcript ?? null,
      active: true,
      created_by: "e2e",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      grants_clearance: body.p_grants_clearance ?? null,
    };
    return json(route, state.video, 1);
  });

  await page.route("**/rest/v1/rpc/save_video_quiz_draft", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    opts.onSaveDraft?.(body);
    state.quiz = {
      id: "quiz-1",
      video_id: body.p_video_id,
      draft_summary: body.p_summary,
      draft_questions: body.p_questions,
      questions: (state.quiz?.questions as unknown) ?? [],
      status: "draft",
      generated_at: "2026-09-01T00:00:00Z",
      approved_by: null,
      approved_at: null,
    };
    return json(route, state.quiz, 1);
  });

  await page.route("**/rest/v1/rpc/approve_video_quiz", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    opts.onApprove?.(body);
    state.quiz = {
      ...(state.quiz ?? {}),
      questions: state.quiz?.draft_questions ?? [],
      status: "approved",
      approved_by: "e2e",
      approved_at: "2026-09-01T00:01:00Z",
    };
    if (state.video) {
      state.video = { ...state.video, summary: state.quiz.draft_summary };
    }
    return json(route, state.quiz, 1);
  });

  await page.route("**/rest/v1/rpc/list_video_quiz", async (route) => {
    return json(route, opts.listQuizResponse ?? null, 1);
  });

  await page.route("**/rest/v1/rpc/submit_video_quiz", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    opts.onSubmit?.(body);
    return json(route, opts.submitResponse ?? null, 1);
  });

  await page.route("**/functions/v1/summarize-learning-video", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "generate") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          skipped: false,
          generation: { summary: "A plain-English summary of the lesson.", questions: FULL_QUESTIONS },
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

test("a supervisor pastes a link and a transcript, generates a draft, and approves it", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const saved: Record<string, unknown>[] = [];
  const drafts: Record<string, unknown>[] = [];
  const approvals: Record<string, unknown>[] = [];
  await useVideoQuizRoutes(page, {
    video: null,
    onSaveVideo: (b) => saved.push(b),
    onSaveDraft: (b) => drafts.push(b),
    onApprove: (b) => approvals.push(b),
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();
  await page.getByRole("button", { name: "Add training video" }).click();

  await page.getByPlaceholder("Installing the XO slider").fill("Installing the corner unit");
  await page.getByPlaceholder("https://youtu.be/…").fill("https://youtu.be/dQw4w9WgXcQ");
  // Transcript Full is the second (last) textarea in the form.
  await page.locator("textarea").last().fill("A full transcript of the lesson, pasted from YouTube.");

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({
    p_title: "Installing the corner unit",
    p_youtube_url: "https://youtu.be/dQw4w9WgXcQ",
    p_transcript: "A full transcript of the lesson, pasted from YouTube.",
  });

  // Back on the list — reopen the video we just saved to reach the quiz tools.
  await expect(page.getByText("Installing the corner unit")).toBeVisible();
  await page.getByRole("button", { name: "✎ Edit" }).click();

  const generateButton = page.getByRole("button", { name: "Generate summary & quiz" });
  await expect(generateButton).toBeEnabled();
  await generateButton.click();

  await expect.poll(() => drafts.length).toBe(1);
  expect(drafts[0].p_video_id).toBe(VIDEO_ID);
  expect((drafts[0].p_questions as unknown[]).length).toBe(5);

  // Draft-first (Q3): a supervisor sees the answer key, and the UI says so
  // plainly that crews cannot see this yet.
  await expect(page.getByText("Draft only — crews can't see this until you Approve & publish it.")).toBeVisible();
  await expect(page.getByText("Question 1?")).toBeVisible();

  await page.getByRole("button", { name: "Approve & publish" }).click();
  await expect.poll(() => approvals.length).toBe(1);
  expect(approvals[0].p_video_id).toBe(VIDEO_ID);
  await expect(page.getByText("Approved and live for crews.", { exact: false })).toBeVisible();
});

test("an installer never sees a draft quiz — the card shows no Take the quiz button", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useVideoQuizRoutes(page, {
    video: {
      id: VIDEO_ID,
      title: "Installing the corner unit",
      window_type_id: null,
      topic: "Corner units",
      video_path: null,
      youtube_url: "https://youtu.be/dQw4w9WgXcQ",
      summary: null,
      transcript: "A full transcript.",
      active: true,
      created_by: "e2e",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      grants_clearance: null,
    },
    // list_video_quiz answers null for a draft-only (or never generated)
    // video — the server-side half of this rule (20260962000000).
    listQuizResponse: null,
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();
  await expect(page.getByText("Installing the corner unit")).toBeVisible();
  await expect(page.getByRole("button", { name: "Take the quiz" })).toHaveCount(0);
});

test("an installer takes an approved quiz, passes, and gets a points toast", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const submissions: Record<string, unknown>[] = [];
  await useVideoQuizRoutes(page, {
    video: {
      id: VIDEO_ID,
      title: "Installing the corner unit",
      window_type_id: null,
      topic: "Corner units",
      video_path: null,
      youtube_url: "https://youtu.be/dQw4w9WgXcQ",
      summary: "A plain-English summary.",
      transcript: "A full transcript.",
      active: true,
      created_by: "e2e",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      grants_clearance: null,
    },
    listQuizResponse: PUBLIC_QUESTIONS,
    onSubmit: (b) => submissions.push(b),
    submitResponse: {
      score: 4,
      passed: true,
      points_awarded: 40,
      cleared: false,
      grants_clearance: null,
      results: FULL_QUESTIONS.map((q) => ({ correct: true, correct_idx: q.correct_idx, why: q.why })),
    },
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();
  await page.getByRole("button", { name: "Take the quiz" }).click();

  for (let i = 0; i < 5; i++) {
    await expect(page.getByText(`Question ${i + 1} of 5`)).toBeVisible();
    // action-list buttons are the 4 answer choices for the current question.
    await page.locator(".action-list .action-btn").first().click();
    const isLast = i === 4;
    await page.getByRole("button", { name: isLast ? "Turn it in" : "Next" }).click();
  }

  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].p_video_id).toBe(VIDEO_ID);
  expect(submissions[0].p_answers).toHaveLength(5);

  // Review, one question at a time, then the final score.
  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "Next" }).click();
  }
  await expect(page.getByText("4/5")).toBeVisible();
  await expect(page.getByText("Passed.")).toBeVisible();
  await expect(page.locator(".toast").filter({ hasText: "+40 points added." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Done" })).toBeVisible();
});

test("a failed attempt shows the score honestly and offers a retake", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await useVideoQuizRoutes(page, {
    video: {
      id: VIDEO_ID,
      title: "Installing the corner unit",
      window_type_id: null,
      topic: "Corner units",
      video_path: null,
      youtube_url: "https://youtu.be/dQw4w9WgXcQ",
      summary: "A plain-English summary.",
      transcript: "A full transcript.",
      active: true,
      created_by: "e2e",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
      grants_clearance: null,
    },
    listQuizResponse: PUBLIC_QUESTIONS,
    submitResponse: {
      score: 2,
      passed: false,
      points_awarded: 0,
      cleared: false,
      grants_clearance: null,
      results: FULL_QUESTIONS.map((q, i) => ({
        correct: i < 2,
        correct_idx: q.correct_idx,
        why: q.why,
      })),
    },
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Videos" }).click();
  await page.getByRole("button", { name: "Take the quiz" }).click();

  for (let i = 0; i < 5; i++) {
    await page.locator(".action-list .action-btn").first().click();
    const isLast = i === 4;
    await page.getByRole("button", { name: isLast ? "Turn it in" : "Next" }).click();
  }

  for (let i = 0; i < 4; i++) {
    await page.getByRole("button", { name: "Next" }).click();
  }
  await expect(page.getByText("2/5")).toBeVisible();
  await expect(page.getByText("Not a pass this time — 4 of 5 to pass.")).toBeVisible();

  const retake = page.getByRole("button", { name: "Retake" });
  await expect(retake).toBeVisible();
  await retake.click();

  // Back to the entry point — a retake is just Take the quiz again.
  await expect(page.getByRole("button", { name: "Take the quiz" })).toBeVisible();
});

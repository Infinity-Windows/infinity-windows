// An installer's gallery is the jobs they have worked; a foreman's is not.
//
// The server is the real rule (20260995000000 narrows `attachments_select`),
// and nothing here can prove RLS — that is scripts/test_schema_verify.py's job.
// What this proves is the half a policy cannot: that the SCREEN agrees with the
// rule. A picker still offering every job in the company would send an
// installer to jobs whose photos come back empty, which reads as a broken app
// rather than as a decision.
//
// House style (photos-kind.spec.ts): mocked routes, real UI, and assert what
// the app actually asks the network for.
import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
const PECAN14 = jobFixtures().find((j) => j.jobCode === "PECAN14")!;

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** Every attachments URL the page asked for, in order. */
function recordPhotoReads(page: Page, into: string[]) {
  return page.route("**/rest/v1/attachments**", (route) => {
    into.push(route.request().url());
    return json(route, [], 0);
  });
}

/** An open shift on BLACK22 — the job this person is standing on today. */
function openShift(projectId: string | null) {
  return {
    id: "shift-1",
    profile_id: "00000000-0000-4000-8000-0000000000e2",
    project_id: projectId,
    cost_code_id: null,
    clock_in_at: new Date(Date.now() - 3_600_000).toISOString(),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: null,
    profiles: { display_name: "E2E Fixture" },
    editor: null,
    voider: null,
  };
}

async function useShift(page: Page, projectId: string | null) {
  await page.route("**/rest/v1/time_shifts**", (route) => {
    if (route.request().method() !== "GET") return json(route, {}, 0);
    return json(route, openShift(projectId), 1);
  });
}

/** The one job this person has worked, as the server would answer it. */
async function useWorkedJobs(page: Page, rows: unknown[], seen?: string[]) {
  await page.route("**/rest/v1/rpc/list_my_worked_jobs**", (route) => {
    seen?.push(route.request().url());
    return json(route, rows, rows.length);
  });
}

/** The picker's option labels, in order. */
async function jobOptions(page: Page): Promise<string[]> {
  return page.getByLabel("Filter by job").locator("option").allInnerTexts();
}

test("an installer's gallery offers only the jobs they have worked", async ({ page }) => {
  const photoReads: string[] = [];
  const workedCalls: string[] = [];
  await useSupabaseFixtures(page, { role: "installer" });
  await recordPhotoReads(page, photoReads);
  await useShift(page, BLACK22.projectId);
  await useWorkedJobs(
    page,
    [{ id: BLACK22.projectId, job_code: "BLACK22", name: "Black Desert" }],
    workedCalls,
  );

  await page.goto("/photos");

  // The page opens ON the job of the open shift, rather than on everything.
  await expect(page).toHaveURL(new RegExp(`project=${BLACK22.projectId}`));

  // One job in the picker — theirs — and the "everything" option says whose.
  await expect(page.getByLabel("Filter by job")).toBeVisible();
  const options = await jobOptions(page);
  expect(options[0]).toBe("All my jobs");
  expect(options.filter((o) => o.includes("PECAN14"))).toEqual([]);
  expect(options.some((o) => o.includes("BLACK22"))).toBe(true);

  // It asked the server which jobs those are, rather than deciding on the phone.
  expect(workedCalls.length).toBeGreaterThan(0);

  // And the feed it settled on is that job's. The first read fires before the
  // shift has answered, so what matters is that no read ever named a job that
  // is not theirs, and that the scoped one happened.
  expect(photoReads.some((u) => u.includes(`project_id=eq.${BLACK22.projectId}`))).toBe(true);
  expect(
    photoReads.filter(
      (u) => u.includes("project_id=eq.") && !u.includes(BLACK22.projectId),
    ),
  ).toEqual([]);

  // An empty grid says whose photos are missing.
  await expect(page.getByText("Photos from the jobs you've worked show here.")).toBeVisible();
});

test("a photo filed to a job they have never worked is still reachable", async ({ page }) => {
  // "See it in the gallery" hands this page the job a photo was just filed to.
  // That job may be one this person has never clocked into — their own shot of
  // it is theirs to look at, so the picker must not drop the job off the list
  // and blank itself.
  await useSupabaseFixtures(page, { role: "installer" });
  await recordPhotoReads(page, []);
  await useShift(page, null);
  await useWorkedJobs(page, [{ id: BLACK22.projectId, job_code: "BLACK22", name: "Black Desert" }]);

  await page.goto(`/photos?project=${PECAN14.projectId}`);

  await expect(page.getByLabel("Filter by job")).toHaveValue(PECAN14.projectId);
  const options = await jobOptions(page);
  expect(options.some((o) => o.includes("PECAN14"))).toBe(true);
  expect(options.some((o) => o.includes("BLACK22"))).toBe(true);
});

test("a phone ahead of the migration still opens the gallery", async ({ page }) => {
  // list_my_worked_jobs does not exist yet. "We cannot tell" is not "you have
  // worked nothing": the page falls back to the full jobs list rather than
  // showing an installer an empty picker over an empty feed.
  await useSupabaseFixtures(page, { role: "installer" });
  await recordPhotoReads(page, []);
  await useShift(page, null);
  await page.route("**/rest/v1/rpc/list_my_worked_jobs**", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        code: "PGRST202",
        message: "Could not find the function public.list_my_worked_jobs",
      }),
    }),
  );

  await page.goto("/photos");

  await expect(page.getByLabel("Filter by job")).toBeVisible();
  const options = await jobOptions(page);
  expect(options.some((o) => o.includes("BLACK22"))).toBe(true);
  expect(options.some((o) => o.includes("PECAN14"))).toBe(true);
});

test("a foreman's gallery is unchanged", async ({ page }) => {
  const photoReads: string[] = [];
  const workedCalls: string[] = [];
  await useSupabaseFixtures(page, { role: "foreman" });
  await recordPhotoReads(page, photoReads);
  await useShift(page, BLACK22.projectId);
  await useWorkedJobs(page, [], workedCalls);

  await page.goto("/photos");

  await expect(page.getByLabel("Filter by job")).toBeVisible();
  const options = await jobOptions(page);
  // Every job, the plain wording, and no auto-jump to the open shift's job.
  expect(options[0]).toBe("All jobs");
  expect(options.some((o) => o.includes("BLACK22"))).toBe(true);
  expect(options.some((o) => o.includes("PECAN14"))).toBe(true);
  await expect(page).not.toHaveURL(/project=/);

  // A foreman's page never asks the worked-jobs question at all — their answer
  // is "all of them", and a round trip to hear it would be waste.
  expect(workedCalls).toEqual([]);

  // Recent across all jobs: the read carries no job filter.
  expect(photoReads.length).toBeGreaterThan(0);
  for (const url of photoReads) {
    expect(url).not.toContain("project_id=eq.");
  }
  await expect(
    page.getByText("Photos from every job show up here as the crew captures them."),
  ).toBeVisible();
});

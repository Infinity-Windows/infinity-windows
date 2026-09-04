// Monday files — the paperwork on a Monday job coming into the app.
//
// Four things a unit test cannot show, which is why they are here:
//
//   F3  the Build form LISTS the row's files, each already pointed at the slot
//       its own name suggests, before anybody presses anything. The guess is a
//       pure function with its own tests; that the office can SEE and CHANGE it
//       is a screen, and a screen is the only place to prove it.
//   F3  building the job sends one pull for the files that stayed ticked, in
//       the slots the pickers hold — and then says, file by file, what became
//       of each one. "2 of 3 pulled" is the sentence that stops somebody
//       assuming the plans are here when they are not.
//   F3  a file that fails NEVER undoes the job. The job is built, the form says
//       where to get the rest, and nothing is rolled back.
//   F5  the Plans page offers only what Monday has and the job does not — the
//       diff against BOTH plansets and documents — and pulls one on a tap.
//
// Every response is mocked at the network layer, the way this suite mocks every
// other edge function: the real endpoint would be talking to another company's
// Monday board, which is the one thing a test must never do.

import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const MONDAY_ROW_ID = "dddddddd-1111-4111-8111-dddddddddddd";
const NEW_PROJECT_ID = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";

/** Real file names off the Ops Gantt Chart (sampled 2026-09-04). */
const FILES = [
  {
    asset_id: "3100578588",
    name: "HC24 - Iron C.pdf",
    ext: ".pdf",
    size: 271770,
    column_id: "files_1",
    uploaded_at: "2026-07-09T19:10:07Z",
  },
  {
    asset_id: "3100578589",
    name: "HC24 - CU.pdf",
    ext: ".pdf",
    size: 837632,
    column_id: "files_1",
    uploaded_at: "2026-07-09T19:10:07Z",
  },
  {
    asset_id: "3100578592",
    name: "HC24 - LP.pdf",
    ext: ".pdf",
    size: 17904294,
    column_id: "files_1",
    uploaded_at: "2026-07-09T19:10:07Z",
  },
];

const STAGED_ROW = {
  id: MONDAY_ROW_ID,
  monday_item_id: "12493379460",
  board_id: "8185408239",
  name: "Richardson Brothers_Hurricane Cliffs 24",
  group_title: "Ready to Schedule",
  status: "Ready for Schedule",
  job_type: "New Build",
  start_date: "2026-10-05",
  end_date: "2026-10-20",
  est_arrival: "2026-09-15",
  budget: 82000,
  flashing_note: null,
  files: FILES,
  synced_at: "2026-09-04T13:00:00Z",
  project_id: null,
  dismissed_at: null,
  left_groups_at: null,
};

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/**
 * Answer monday-sync from fixtures and remember every call.
 *
 * Registered AFTER useSupabaseFixtures so it wins — Playwright favours the most
 * recently added route, and the fixture router answers every edge function with
 * a 501.
 */
function routeMondaySync(
  page: Page,
  outcome: (files: { asset_id: string; kind: string }[]) => unknown[],
): { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  void page.route("**/functions/v1/monday-sync", (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push(body);
    if (body.action !== "pull_files") {
      // The Jobs page nudges the ordinary board sync on every visit.
      return json(r, { ok: true, synced: 0 });
    }
    const files = (body.files ?? []) as { asset_id: string; kind: string }[];
    // The function's real shape: `ok` says the request was handled, and each
    // file carries its own answer.
    return json(r, { ok: true, results: outcome(files) });
  });
  return { calls };
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

/** The staged row, the empty jobs list, and the row's link-up PATCH. */
function routeIncoming(page: Page): { patched: Record<string, unknown>[] } {
  const patched: Record<string, unknown>[] = [];
  void page.route("**/rest/v1/monday_jobs**", (r) => {
    if (r.request().method() === "PATCH") {
      patched.push(r.request().postDataJSON() as Record<string, unknown>);
      return json(r, null, 0);
    }
    return json(r, [STAGED_ROW], 1);
  });
  void page.route("**/rest/v1/projects**", (r) => {
    if (r.request().method() === "POST") {
      return json(
        r,
        {
          id: NEW_PROJECT_ID,
          job_code: "HC24",
          name: "Richardson Brothers_Hurricane Cliffs 24",
          status: "active",
          allowed_modes: ["data"],
        },
        1,
      );
    }
    return json(r, [], 0);
  });
  return { patched };
}

test("the Build form lists the Monday files with the right slot already chosen", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  routeIncoming(page);
  routeMondaySync(page, (files) =>
    files.map((f) => ({
      asset_id: f.asset_id,
      name: "",
      ok: true,
      where: f.kind === "building" ? "plans" : f.kind === "specs" ? "specs" : "documents",
    })),
  );

  await page.goto("/projects");
  await page
    .locator("li", { hasText: "Hurricane Cliffs 24" })
    .getByRole("button", { name: "Build project" })
    .click();

  const list = page.getByTestId("monday-build-files");
  await expect(list.locator("li")).toHaveCount(3);

  // The office's own shorthand, read for them: "LP" is the plans, "CU" is the
  // specs, and the ironwork sheet is a document.
  await expect(list.locator("li").filter({ hasText: "HC24 - LP.pdf" }).locator("select"))
    .toHaveValue("building");
  await expect(list.locator("li").filter({ hasText: "HC24 - CU.pdf" }).locator("select"))
    .toHaveValue("specs");
  await expect(
    list.locator("li").filter({ hasText: "HC24 - Iron C.pdf" }).locator("select"),
  ).toHaveValue("document");

  // The size is on screen, because 17 MB over cell signal is a decision.
  await expect(list.locator("li").filter({ hasText: "HC24 - LP.pdf" })).toContainText("17 MB");

  // Everything is ticked. Taking the paperwork is the ordinary case.
  for (const box of await list.locator('input[type="checkbox"]').all()) {
    await expect(box).toBeChecked();
  }
});

test("building the job pulls the files that stayed ticked, in the slots the office chose", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const { patched } = routeIncoming(page);
  const { calls } = routeMondaySync(page, (files) =>
    files.map((f) => ({
      asset_id: f.asset_id,
      name: "",
      ok: true,
      where: f.kind === "building" ? "plans" : f.kind === "specs" ? "specs" : "documents",
    })),
  );

  await page.goto("/projects");
  await page
    .locator("li", { hasText: "Hurricane Cliffs 24" })
    .getByRole("button", { name: "Build project" })
    .click();

  const list = page.getByTestId("monday-build-files");
  // Leave the ironwork order behind, and correct the guess on the CU sheet.
  await list
    .locator("li")
    .filter({ hasText: "HC24 - Iron C.pdf" })
    .locator('input[type="checkbox"]')
    .uncheck();
  await list
    .locator("li")
    .filter({ hasText: "HC24 - CU.pdf" })
    .locator("select")
    .selectOption("building");

  await page.getByRole("button", { name: "Build project" }).last().click();

  await expect(page.getByTestId("monday-pull-note")).toBeVisible();

  // The job was built and linked BEFORE anything was fetched.
  expect(patched.some((p) => p.project_id === NEW_PROJECT_ID)).toBe(true);

  const pull = calls.find((c) => c.action === "pull_files");
  expect(pull).toBeTruthy();
  expect(pull?.monday_job_id).toBe(MONDAY_ROW_ID);
  expect(pull?.project_id).toBe(NEW_PROJECT_ID);
  expect(pull?.files).toEqual([
    { asset_id: "3100578589", kind: "building" },
    { asset_id: "3100578592", kind: "building" },
  ]);
});

test("a file that will not come across never undoes the job", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const { patched } = routeIncoming(page);
  routeMondaySync(page, (files) =>
    files.map((f, i) => ({
      asset_id: f.asset_id,
      name: FILES.find((x) => x.asset_id === f.asset_id)?.name ?? "",
      ok: i > 0,
      where: i > 0 ? "plans" : null,
      error: i > 0 ? null : "This file is 96 MB. Anything over 80 MB has to be added by hand.",
    })),
  );

  await page.goto("/projects");
  await page
    .locator("li", { hasText: "Hurricane Cliffs 24" })
    .getByRole("button", { name: "Build project" })
    .click();
  await page.getByRole("button", { name: "Build project" }).last().click();

  // The job is built and stays built, and the sentence says where the rest is.
  await expect(page.getByTestId("monday-pull-note")).toContainText("2 of 3");
  await expect(page.getByTestId("monday-pull-note")).toContainText("Plans page");
  expect(patched.some((p) => p.project_id === NEW_PROJECT_ID)).toBe(true);

  // And the one that failed says why, in the server's own plain sentence.
  await expect(
    page.getByTestId("monday-pull-result").filter({ hasText: "HC24 - Iron C.pdf" }),
  ).toContainText("80 MB");
});

test("the Plans page offers only what Monday has and the job does not", async ({ page }) => {
  const job = jobFixtures()[0];
  await useSupabaseFixtures(page, { role: "foreman" });

  // The LP sheet is already here as a planset; the ironwork order is already
  // here as a document. Only the CU sheet is new.
  void page.route("**/rest/v1/project_plansets**", (r) =>
    json(
      r,
      [
        {
          id: "ps-1",
          project_id: job.projectId,
          storage_path: `${job.projectId}/1-HC24_-_LP.pdf`,
          source_format: "pdf",
          converted_pdf_path: null,
          page_count: 12,
          status: "uploaded",
          kind: "building",
          source_asset_id: "3100578592",
          created_at: "2026-09-04T13:00:00Z",
        },
      ],
      1,
    ),
  );
  void page.route("**/rest/v1/project_documents**", (r) =>
    json(
      r,
      [
        {
          id: "doc-1",
          project_id: job.projectId,
          name: "HC24 - Iron C.pdf",
          storage_path: `${job.projectId}/1-HC24_-_Iron_C.pdf`,
          size_bytes: 271770,
          content_type: "application/pdf",
          source: "monday",
          source_asset_id: "3100578588",
          created_by: null,
          created_at: "2026-09-04T13:00:00Z",
        },
      ],
      1,
    ),
  );
  void page.route("**/rest/v1/monday_jobs**", (r) =>
    json(r, { ...STAGED_ROW, project_id: job.projectId }, 1),
  );
  const { calls } = routeMondaySync(page, (files) =>
    files.map((f) => ({ asset_id: f.asset_id, name: "", ok: true, where: "specs" })),
  );

  await page.goto(`/projects/${job.projectId}/upload`);

  const block = page.getByTestId("files-on-monday");
  await expect(block).toBeVisible();
  await expect(block.locator("li")).toHaveCount(1);
  await expect(block).toContainText("HC24 - CU.pdf");
  // The two already here are not offered again — and the document counts,
  // otherwise a file pulled as a document would keep offering itself as a plan.
  await expect(block).not.toContainText("HC24 - LP.pdf");
  await expect(block).not.toContainText("HC24 - Iron C.pdf");

  // The planset that came from Monday says so.
  await expect(page.getByTestId("from-monday").first()).toBeVisible();

  await block.getByTestId("pull-from-monday").click();
  await expect(page.getByTestId("monday-pull-note")).toBeVisible();

  const pull = calls.find((c) => c.action === "pull_files");
  expect(pull?.project_id).toBe(job.projectId);
  expect(pull?.files).toEqual([{ asset_id: "3100578589", kind: "specs" }]);
});

test("a refusal from the server is read as the sentence the server wrote", async ({
  page,
}) => {
  // Every whole-request refusal the pull writes — "Only a foreman or above…",
  // "Getting files from Monday needs the next database update." — comes back
  // with an http status, and supabase-js answers ANY non-2xx with the fixed
  // string "Edge Function returned a non-2xx status code" and throws the body
  // away. That is the incident monday-sync's own header already records once,
  // and nothing in this suite exercised it because every mock here answers 200.
  const job = jobFixtures()[0];
  await useSupabaseFixtures(page, { role: "foreman" });

  void page.route("**/rest/v1/project_plansets**", (r) => json(r, [], 0));
  void page.route("**/rest/v1/project_documents**", (r) => json(r, [], 0));
  void page.route("**/rest/v1/monday_jobs**", (r) =>
    json(r, { ...STAGED_ROW, project_id: job.projectId }, 1),
  );
  void page.route("**/functions/v1/monday-sync", (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (body.action !== "pull_files") return json(r, { ok: true, synced: 0 });
    return r.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: "Getting files from Monday needs the next database update.",
      }),
    });
  });

  await page.goto(`/projects/${job.projectId}/upload`);
  await page.getByTestId("files-on-monday").getByTestId("pull-from-monday").first().click();

  const note = page.getByTestId("monday-pull-note");
  await expect(note).toContainText("needs the next database update");
  await expect(note).not.toContainText("non-2xx");
});

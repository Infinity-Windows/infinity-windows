// Bulk remove (owner, 2026-08-20): a bad extraction leaves N wrong marks, and
// removing them one confirm at a time is N trips through the same dialog. The
// review screen's "Remove several…" sweep selects marks and removes them in
// one confirmed pass, through the same remove_opening RPC with all its guards.
import { test, expect } from "@playwright/test";
import {
  jobFixtures,
  openingsFor,
  useSupabaseFixtures,
} from "./support/supabaseFixtures";

// The sweep only offers planned marks (installed ones refuse server-side
// anyway), so pick a fixture job that has at least two to select.
const job = jobFixtures().find(
  (j) =>
    openingsFor(j.projectId).filter(
      (o) => (o as { status?: string }).status === "planned",
    ).length >= 2,
)!;

test("a foreman removes several openings in one confirmed sweep", async ({
  page,
}) => {
  expect(job, "a fixture job with 2+ planned openings").toBeTruthy();
  await useSupabaseFixtures(page, { role: "foreman" });

  const removedIds: string[] = [];
  await page.route("**/rest/v1/rpc/remove_opening", async (route) => {
    const body = route.request().postDataJSON() as { p_opening_id: string };
    removedIds.push(body.p_opening_id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
  await page.route("**/rest/v1/rpc/list_removed_openings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  page.on("dialog", (d) => void d.accept());

  await page.goto(`/projects/${job.projectId}/review`);
  await page.getByRole("button", { name: "Remove several…" }).click();

  const boxes = page.locator('.opening-review-row input[type="checkbox"]');
  await boxes.first().check();
  await boxes.nth(1).check();
  await page.getByRole("button", { name: "Remove 2 selected" }).click();

  // One sweep, two RPC calls, and the outcome said in plain words.
  await expect(page.locator(".error")).toContainText("Removed 2 openings");
  expect(removedIds).toHaveLength(2);
  expect(new Set(removedIds).size).toBe(2);
});

// SINGLE-opening remove (OpeningReview.tsx:143's askThenRemove): the
// day-to-day path for one wrong mark, as opposed to the sweep above. The
// screen still uses window.confirm here today — pick 10 changes that later,
// and this test only needs its one line of dialog handling touched when it
// does.
test("a foreman removes a single opening, and the row leaves the list", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  // A mutable stand-in for the project's openings: the default fixture
  // router always answers from the static fixture array, but this test
  // needs the list to actually lose a row once remove_opening "lands".
  let openingsList = [...openingsFor(job.projectId)];
  const target = openingsList.find(
    (o) => (o as { status?: string }).status === "planned",
  )!;
  expect(target, "a fixture opening with status planned").toBeTruthy();

  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      url.searchParams.has("project_id"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "content-range": `0-${Math.max(0, openingsList.length - 1)}/${openingsList.length}`,
        },
        body: JSON.stringify(openingsList),
      }),
  );
  await page.route("**/rest/v1/rpc/list_removed_openings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  const removed: { opening: string; reason: string | null }[] = [];
  await page.route("**/rest/v1/rpc/remove_opening", async (route) => {
    const body = route.request().postDataJSON() as {
      p_opening_id: string;
      p_reason: string | null;
    };
    removed.push({ opening: body.p_opening_id, reason: body.p_reason });
    openingsList = openingsList.filter((o) => o.id !== body.p_opening_id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    });
  });
  page.on("dialog", (d) => void d.accept());

  await page.goto(`/projects/${job.projectId}/review`);
  const row = page.locator(".opening-review-row").filter({
    has: page.locator(`input.opening-code-input[value="${target.opening_code}"]`),
  });
  await row.getByRole("button", { name: "Remove" }).click();

  await expect.poll(() => removed.length).toBe(1);
  expect(removed[0]).toEqual({ opening: target.id, reason: null });

  // The row leaves the list: the refetch after remove_opening no longer
  // carries this opening's code among the rendered rows.
  await expect
    .poll(() =>
      page
        .locator("input.opening-code-input")
        .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value)),
    )
    .not.toContain(target.opening_code);
});

// PUT-BACK: the other half of remove — nothing about a removed opening was
// deleted, and restore_opening is how it comes back.
test("putting a removed opening back returns it to the list", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  const restored = openingsFor(job.projectId)[1];
  // Starts OUT of the main list and IN the removed list — the state a real
  // database would be in the moment after someone removed it.
  let openingsList = openingsFor(job.projectId).filter(
    (o) => o.id !== restored.id,
  );
  let removedList = [
    {
      id: restored.id,
      opening_code: restored.opening_code,
      label: null as string | null,
      window_type_id: null as string | null,
      status: "planned",
      removed_at: "2026-08-24T10:00:00Z",
      removed_by: null as string | null,
      removed_by_name: "E2E Fixture",
      removed_reason: "removed for a put-back test",
      code_taken: false,
    },
  ];

  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      url.searchParams.has("project_id"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "content-range": `0-${Math.max(0, openingsList.length - 1)}/${openingsList.length}`,
        },
        body: JSON.stringify(openingsList),
      }),
  );
  await page.route("**/rest/v1/rpc/list_removed_openings", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(removedList),
    }),
  );
  const restoreCalls: string[] = [];
  await page.route("**/rest/v1/rpc/restore_opening", async (route) => {
    const body = route.request().postDataJSON() as { p_opening_id: string };
    restoreCalls.push(body.p_opening_id);
    openingsList = [...openingsList, restored];
    removedList = [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    });
  });

  await page.goto(`/projects/${job.projectId}/review`);
  await expect(page.getByRole("heading", { name: /Removed/ })).toBeVisible();
  await page.getByRole("button", { name: "Put back" }).click();

  await expect.poll(() => restoreCalls.length).toBe(1);
  expect(restoreCalls[0]).toBe(restored.id);

  // Its row returns: the refetch after restore_opening carries this
  // opening's code again among the rendered rows.
  await expect
    .poll(() =>
      page
        .locator("input.opening-code-input")
        .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value)),
    )
    .toContain(restored.opening_code);
});

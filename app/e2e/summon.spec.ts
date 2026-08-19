// Summon (owner, 2026-08-14): a helper arriving at a rung window sees the
// live summon on the opening sheet and Answer fires the real RPC.
import { test, expect } from "@playwright/test";
import { jobFixtures, openingsFor, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

test("a live summon renders on the sheet and Answer fires the RPC", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const opening = openingsFor(BLACK22.projectId)[0];
  const summonId = "00000000-0000-4000-8000-00000000d00d";

  // The fixture router only answers project_id-filtered opening queries;
  // the sheet fetches by id. Serve that one row ourselves (newest-first
  // route registration wins).
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      (url.searchParams.get("id") ?? "").startsWith("eq."),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/1" },
        body: JSON.stringify([opening]),
      }),
  );

  await page.route("**/rest/v1/summons**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: summonId,
          project_id: BLACK22.projectId,
          opening_id: opening.id,
          requested_by: "00000000-0000-4000-8000-00000000aaaa",
          needed: 3,
          status: "open",
          created_at: "2026-08-14T18:00:00Z",
          closed_at: null,
          requester: { display_name: "Marcus" },
        },
      ]),
    }),
  );
  await page.route("**/rest/v1/summon_helpers**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "*/0" },
      body: "[]",
    }),
  );

  const answered: string[] = [];
  await page.route("**/rest/v1/rpc/answer_summon", async (route) => {
    const body = route.request().postDataJSON() as { p_summon_id: string };
    answered.push(body.p_summon_id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "h1",
        summon_id: body.p_summon_id,
        profile_id: "me",
        joined_at: "2026-08-14T18:05:00Z",
        completed_at: null,
        minutes: null,
      }),
    });
  });

  await page.goto(`/projects/${BLACK22.projectId}/opening/${opening.id}`);
  await expect(page.getByText(/Summon — 0\/3/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /Answer — help carry/ }).click();
  await expect.poll(() => answered.length).toBe(1);
  expect(answered[0]).toBe(summonId);
});

test("a live summon rides My Work, so helpers see it without opening the job (owner ask, 2026-08-18)", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const opening = openingsFor(BLACK22.projectId)[0];
  const summonId = "00000000-0000-4000-8000-00000000d00e";

  await page.route("**/rest/v1/summons**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: summonId,
          project_id: BLACK22.projectId,
          opening_id: opening.id,
          requested_by: "00000000-0000-4000-8000-00000000aaaa",
          needed: 3,
          status: "open",
          created_at: "2026-08-14T18:00:00Z",
          closed_at: null,
          requester: { display_name: "Marcus" },
          project: { job_code: "BLACK22" },
          opening: { opening_code: opening.opening_code },
        },
      ]),
    }),
  );

  await page.goto("/");
  const row = page.getByRole("link", { name: /Marcus needs 3 hands — BLACK22/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute(
    "href",
    `/projects/${BLACK22.projectId}/opening/${opening.id}`,
  );
});

// Summon (owner, 2026-08-14): a helper arriving at a rung window sees the
// live summon on the opening sheet and Answer fires the real RPC.
import { test, expect } from "@playwright/test";
import { jobFixtures, openingsFor, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

// A summon is over one day after it was sent (owner ask, 2026-09-02), so
// these fixtures date themselves against the clock the test runs on — a
// hard-coded date would age into an expired call and stop rendering.
const SENT_JUST_NOW = new Date(Date.now() - 30 * 60_000).toISOString();

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
          created_at: SENT_JUST_NOW,
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
          created_at: SENT_JUST_NOW,
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

test("Can't help fires the decline RPC and the name shows in the can't-come line", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const opening = openingsFor(BLACK22.projectId)[0];
  const summonId = "00000000-0000-4000-8000-00000000d00f";

  // Same fixture-router workaround as the first test above: serve the
  // by-id opening fetch ourselves.
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
          created_at: SENT_JUST_NOW,
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

  // The declines list starts empty and flips once the RPC below fires — the
  // panel refetches on its own (same invalidate-then-refetch pattern the
  // answer flow uses), so returning the decline row here is enough to prove
  // the live update, without touching the panel's realtime channel.
  let declined = false;
  await page.route("**/rest/v1/summon_declines**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": declined ? "0-0/1" : "*/0" },
      body: declined
        ? JSON.stringify([
            {
              summon_id: summonId,
              profile_id: "00000000-0000-4000-8000-00000000cccc",
              created_at: "2026-08-21T18:05:00Z",
              decliner: { display_name: "Chris" },
            },
          ])
        : "[]",
    }),
  );

  const declines: string[] = [];
  await page.route("**/rest/v1/rpc/decline_summon", async (route) => {
    const body = route.request().postDataJSON() as { p_summon_id: string };
    declines.push(body.p_summon_id);
    declined = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        summon_id: body.p_summon_id,
        profile_id: "00000000-0000-4000-8000-00000000cccc",
        created_at: "2026-08-21T18:05:00Z",
      }),
    });
  });

  await page.goto(`/projects/${BLACK22.projectId}/opening/${opening.id}`);
  await expect(page.getByText(/Summon — 0\/3/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Can't help", exact: true }).click();
  await expect.poll(() => declines.length).toBe(1);
  expect(declines[0]).toBe(summonId);

  // "Can't come" uses a curly apostrophe in the source (&rsquo;) — match
  // around it rather than assuming which glyph renders.
  await expect(page.getByText(/Can.t come: Chris/)).toBeVisible();
});

test("Decline takes the summon off My Work without opening the window (owner ask, 2026-09-02)", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const opening = openingsFor(BLACK22.projectId)[0];
  const summonId = "00000000-0000-4000-8000-00000000d010";

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
          needed: 4,
          status: "open",
          created_at: SENT_JUST_NOW,
          closed_at: null,
          requester: { display_name: "Enrique landa" },
          project: { job_code: "BLACK22" },
          opening: { opening_code: opening.opening_code },
        },
      ]),
    }),
  );

  const declines: string[] = [];
  await page.route("**/rest/v1/rpc/decline_summon", async (route) => {
    const body = route.request().postDataJSON() as { p_summon_id: string };
    declines.push(body.p_summon_id);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        summon_id: body.p_summon_id,
        profile_id: "00000000-0000-4000-8000-0000000000e2",
        created_at: new Date().toISOString(),
      }),
    });
  });

  await page.goto("/");
  const row = page.getByRole("link", { name: /Enrique landa needs 4 hands — BLACK22/ });
  await expect(row).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect.poll(() => declines.length).toBe(1);
  expect(declines[0]).toBe(summonId);

  // Off the screen, and still on My Work — Decline is not a way into the job.
  await expect(row).toHaveCount(0);
  expect(page.url()).not.toContain("/opening/");
});

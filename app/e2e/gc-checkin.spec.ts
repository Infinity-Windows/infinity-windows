// Wave H (H1) — the GC card on a real job's Overview.
//
// Four things this proves that a unit test cannot:
//   - the card reads "nobody has checked in yet" on a job with no history, and
//     the Pipeline card above it agrees ("None yet") rather than the two
//     disagreeing on the same screen.
//   - a foreman fills the six answers in and ONE RPC goes over with all six,
//     the way log_gc_checkin expects them.
//   - the browser refuses a half-filled check-in before the server has to, and
//     names the box that is empty rather than saying "fill in the form".
//   - an installer reads every answer and is never offered the button. Knowing
//     the GC wants the windows outset is exactly what an installer needs before
//     touching an elevation; filing it is a foreman's job.

import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const PROJECT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

const PROJECT = {
  id: PROJECT_ID,
  job_code: "SANDHOLLOW",
  name: "Sand Hollow",
  address: null,
  status: "active",
  is_test: false,
  allowed_modes: ["data"],
  start_date: null,
  sort_order: 1,
  gc_brand: "stg",
  // Wave H (H0) shape: readiness rides the embedded side table, never the row.
  project_pipeline: { ready_state: "ready", materials_eta: null, materials_arrived_at: null },
};

const EXISTING_CHECKIN = {
  id: "cccccccc-1111-4111-8111-cccccccccccc",
  project_id: PROJECT_ID,
  author_id: null,
  contacted_at: "2026-08-01T16:00:00Z",
  contact_name: "Dave at Dixie",
  channel: "call",
  expected_end_date: "2026-11-20",
  roof_on_date: "2026-09-30",
  framing_checked: true,
  set_preference: "outset",
  exterior_material: "Stucco",
  interior_material: "Drywall",
  notes: "Gate code changes next week.",
  source: "crew",
  created_at: "2026-08-01T16:05:00Z",
};

/**
 * A jobs route plus a check-in table that remembers what the RPC did to it, so
 * "file one and the card stops saying nobody has called" is a real assertion
 * rather than a screenshot of an optimistic update.
 */
function useGcFixtures(page: Page, seed: Record<string, unknown>[] = []) {
  const state = { checkins: [...seed] };
  const calls: { fn: string; body: Record<string, unknown> }[] = [];

  void page.route("**/rest/v1/rpc/log_gc_checkin", async (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    calls.push({ fn: "log_gc_checkin", body });
    state.checkins = [
      {
        ...EXISTING_CHECKIN,
        id: `filed-${state.checkins.length}`,
        contacted_at: new Date().toISOString(),
        contact_name: body.p_contact_name,
        channel: body.p_channel,
        expected_end_date: body.p_expected_end_date,
        roof_on_date: body.p_roof_on_date,
        framing_checked: body.p_framing_checked,
        set_preference: body.p_set_preference,
        exterior_material: body.p_exterior_material,
        interior_material: body.p_interior_material,
        notes: body.p_notes,
      },
      ...state.checkins,
    ];
    return json(r, null, 0);
  });

  void page.route("**/rest/v1/project_gc_checkins**", (r) =>
    json(r, state.checkins, state.checkins.length),
  );

  void page.route("**/rest/v1/projects**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, PROJECT, 1);
    return json(r, [PROJECT], 1);
  });

  return { calls, checkins: () => state.checkins };
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const gcCard = (page: Page) =>
  page.locator("section.detail-card").filter({ hasText: "GC" }).last();

test("a job nobody has called about says so, on both cards", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  useGcFixtures(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  const card = gcCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText(/Nobody has checked in with the GC yet/i)).toBeVisible();

  // The Pipeline card above it reads the SAME query, so the two cannot
  // disagree on one screen about whether anybody has called.
  const pipeline = page.locator("section.detail-card").filter({ hasText: "Pipeline" }).first();
  await expect(pipeline.getByText(/None yet/i)).toBeVisible();
});

test("the Pipeline card shows the day the GC was last spoken to", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  useGcFixtures(page, [EXISTING_CHECKIN]);
  await page.goto(`/projects/${PROJECT_ID}`);

  // "Last GC check-in" is a PIPELINE fact — one of the four reasons the 7 AM
  // push exists — so it belongs on that card and not only on the GC card, and
  // it must read the real date rather than the seam's "None yet".
  const pipeline = page.locator("section.detail-card").filter({ hasText: "Pipeline" }).first();
  await expect(pipeline.getByText(/None yet/i)).toHaveCount(0);
  await expect(pipeline.getByText(/Aug 1/)).toBeVisible();
});

test("a foreman files the six answers and one call carries all of them", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const fixtures = useGcFixtures(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  const card = gcCard(page);
  await card.getByRole("button", { name: /Log a GC check-in/i }).click();

  await card.getByLabel("House finished").fill("2026-11-20");
  await card.getByLabel("Roof on").fill("2026-09-30");
  await card.getByRole("button", { name: /^Yes$/ }).click();
  await card.getByRole("button", { name: /^Outset$/ }).click();
  await card.getByLabel("Going on the outside").fill("Stucco");
  await card.getByLabel("Going on the inside").fill("Drywall");
  await card.getByLabel("Who you talked to").fill("Dave at Dixie");
  await card.getByRole("button", { name: /File this check-in/i }).click();

  await expect.poll(() => fixtures.calls.length).toBeGreaterThan(0);
  const body = fixtures.calls[0].body;
  // All six, in one RPC. A card that saved them one field at a time would leave
  // half a check-in on the record when a phone lost signal mid-form.
  expect(body.p_project_id).toBe(PROJECT_ID);
  expect(body.p_expected_end_date).toBe("2026-11-20");
  expect(body.p_roof_on_date).toBe("2026-09-30");
  expect(body.p_framing_checked).toBe(true);
  expect(body.p_set_preference).toBe("outset");
  expect(body.p_exterior_material).toBe("Stucco");
  expect(body.p_interior_material).toBe("Drywall");
  expect(body.p_contact_name).toBe("Dave at Dixie");

  // And the job stops asking to be called.
  await expect(card.getByText(/The job stops asking for a call/i)).toBeVisible();
});

test("a half-filled check-in never reaches the server, and names the empty box", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const fixtures = useGcFixtures(page);
  await page.goto(`/projects/${PROJECT_ID}`);

  const card = gcCard(page);
  await card.getByRole("button", { name: /Log a GC check-in/i }).click();
  await card.getByLabel("House finished").fill("2026-11-20");
  await card.getByRole("button", { name: /File this check-in/i }).click();

  // The message points at the NEXT empty box in form order, not at the form.
  await expect(card.getByText(/Say when the roof goes on/i)).toBeVisible();
  expect(fixtures.calls).toHaveLength(0);
});

test("an installer reads what the GC said and is never offered the button", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  useGcFixtures(page, [EXISTING_CHECKIN]);
  await page.goto(`/projects/${PROJECT_ID}`);

  const card = gcCard(page);
  await expect(card).toBeVisible();
  // Knowing the builder wants them outset is exactly what an installer needs
  // before touching an elevation.
  await expect(card.getByText("Outset", { exact: true })).toBeVisible();
  await expect(card.getByText("Stucco")).toBeVisible();
  await expect(card.getByRole("button", { name: /Log a GC check-in/i })).toHaveCount(0);
});

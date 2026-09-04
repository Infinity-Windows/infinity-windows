// Wave J — the job pipeline, on the real Jobs page and the real job hub.
//
// Four things this proves that a unit test cannot:
//   J1  a job card wears "Not ready" beside its mode badge and reads
//       "Not ready · start ~… · windows ETA …", while a job that is ready with
//       its windows in wears nothing at all.
//   J4  the "Needs a call" chip appears on the job that has a reason and only
//       on that job.
//   J1  the Pipeline card on Overview marks the windows arrived in one tap,
//       and an installer can read the card without being able to change it.
//   J2  a foreman reorders the list with the up/down buttons, the whole new
//       order goes to the server, AND IT SURVIVES A RELOAD — which is the
//       whole point of an order that lives in the database rather than in a
//       tab's memory.
//
// The jobs are hand-built rather than captured, because the geometry is the
// test: one job starting inside the fortnight with no windows, one starting
// inside the fortnight that is fine, and one whose promised ETA has passed.

import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const NOT_READY_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const FINE_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const LATE_ID = "cccccccc-3333-4333-8333-cccccccccccc";

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function project(over: Record<string, unknown>) {
  return {
    id: NOT_READY_ID,
    job_code: "SANDHOLLOW",
    name: "Sand Hollow",
    address: null,
    status: "active",
    is_test: false,
    allowed_modes: ["data"],
    ready_state: "ready",
    start_date: null,
    materials_eta: null,
    materials_arrived_at: null,
    sort_order: null,
    ...over,
  };
}

// Starts in ten days, nobody has said it is ready, and the windows are still
// due — the exact job the 7 AM sweep would push about.
// The contact details are here on purpose: the Pipeline card can save this
// job's start date, and the test below proves it takes none of them with it.
const NOT_READY = project({
  ready_state: "not_ready",
  start_date: day(10),
  materials_eta: day(4),
  sort_order: 1,
  address: "1 Sand Hollow Way",
  customer_name: "Dixie Builders",
  contact_phone: "435-555-0100",
  contact_email: "site@dixiebuilders.test",
  notes: "Gate code 1234, dogs on site.",
});

// Starts in a week and is completely fine. Wears no pill and no chip.
const FINE = project({
  id: FINE_ID,
  job_code: "PECAN14",
  name: "Pecan Valley",
  start_date: day(7),
  materials_eta: day(-20),
  materials_arrived_at: `${day(-20)}T15:00:00Z`,
  sort_order: 2,
});

// The windows were promised a fortnight ago and nothing has arrived. Late is
// late whether the job starts next week or next spring.
const LATE = project({
  id: LATE_ID,
  job_code: "BLACK22",
  name: "Black Desert",
  start_date: day(120),
  materials_eta: day(-14),
  sort_order: 3,
});

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/**
 * A projects route that remembers what the RPCs did to it, the way the real
 * database would.
 *
 * This is what makes the reorder test mean something: `set_projects_order`
 * rewrites `sort_order` here, the page refetches, and a full page reload reads
 * the same rewritten rows — so an order that only lived in React state would
 * fail this test, which is exactly the bug worth catching.
 *
 * Registered AFTER useSupabaseFixtures so it wins (Playwright favours the most
 * recently added route).
 */
function usePipelineFixtures(page: Page) {
  const state = { rows: [NOT_READY, FINE, LATE] as Record<string, unknown>[] };
  const calls: { fn: string; body: unknown }[] = [];

  void page.route("**/rest/v1/rpc/set_projects_order", async (r) => {
    const body = r.request().postDataJSON() as { p_ids: string[] };
    calls.push({ fn: "set_projects_order", body });
    state.rows = state.rows.map((row) => {
      const at = body.p_ids.indexOf(row.id as string);
      return at === -1 ? row : { ...row, sort_order: at + 1 };
    });
    return json(r, null, 0);
  });

  void page.route("**/rest/v1/rpc/set_project_materials", async (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    calls.push({ fn: "set_project_materials", body });
    state.rows = state.rows.map((row) =>
      row.id === body.p_project_id
        ? {
            ...row,
            materials_arrived_at:
              body.p_arrived === true ? new Date().toISOString() : row.materials_arrived_at,
          }
        : row,
    );
    return json(r, null, 0);
  });

  void page.route("**/rest/v1/rpc/set_project_readiness", async (r) => {
    calls.push({ fn: "set_project_readiness", body: r.request().postDataJSON() });
    return json(r, null, 0);
  });

  void page.route("**/rest/v1/projects**", (r) => {
    const request = r.request();

    // The inline "Expected start" edit is an ordinary PATCH on the row, not an
    // RPC — start_date rides wave D's column grant. Recording the BODY is the
    // point: a writer that filled in the columns the card does not hold would
    // blank this job's address, customer and notes on the way past.
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push({ fn: "PATCH projects", body });
      const id = /id=eq\.([^&]+)/.exec(request.url())?.[1] ?? "";
      state.rows = state.rows.map((row) => (row.id === id ? { ...row, ...body } : row));
      const patched = state.rows.find((row) => row.id === id) ?? null;
      return json(r, patched, patched ? 1 : 0);
    }

    // The server's own order, so the page gets the list already sorted the way
    // lib/api.ts asks PostgREST for it.
    const rows = [...state.rows].sort(
      (a, b) => ((a.sort_order as number) ?? 1e9) - ((b.sort_order as number) ?? 1e9),
    );
    const accept = request.headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, rows[0] ?? null, rows.length);
    return json(r, rows, rows.length);
  });

  return { calls, order: () => state.rows.map((row) => [row.id, row.sort_order]) };
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

/** The names on the cards, top to bottom. */
async function cardOrder(page: Page): Promise<string[]> {
  const names = await page.locator("a.project-card").allInnerTexts();
  return names.map((text) => text.split("\n")[0].trim());
}

test("a job card says it is not ready, when it starts, and when the windows land", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  usePipelineFixtures(page);
  await page.goto("/projects");

  const sandHollow = page.locator("a.project-card").filter({ hasText: "Sand Hollow" });
  await expect(sandHollow).toBeVisible();
  // The pill sits BESIDE the mode badge, not instead of it.
  await expect(sandHollow.locator(".job-ready-badge")).toHaveText(/Not ready/i);
  await expect(sandHollow.locator(".job-mode-badge")).toBeVisible();
  // "Not ready · start ~Sep 22 · windows ETA Sep 15"
  await expect(sandHollow.locator(".job-pipeline-line")).toHaveText(
    /Not ready · start ~.+ · windows ETA .+/,
  );

  // A job that is ready with its windows in wears none of it — absence is the
  // quiet state, so the card missing a sticker is never the one that matters.
  const pecan = page.locator("a.project-card").filter({ hasText: "Pecan Valley" });
  await expect(pecan.locator(".job-ready-badge")).toHaveCount(0);
  await expect(pecan.locator(".job-needs-call")).toHaveCount(0);
});

test("Needs a call lands on the jobs with a reason and nowhere else", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  usePipelineFixtures(page);
  await page.goto("/projects");

  await expect(
    page.locator("a.project-card").filter({ hasText: "Sand Hollow" }).locator(".job-needs-call"),
  ).toHaveCount(1);
  // Late windows are late even though this job does not start for months.
  await expect(
    page.locator("a.project-card").filter({ hasText: "Black Desert" }).locator(".job-needs-call"),
  ).toHaveCount(1);
  await expect(
    page.locator("a.project-card").filter({ hasText: "Pecan Valley" }).locator(".job-needs-call"),
  ).toHaveCount(0);
});

test("the order a foreman puts the jobs in survives a reload", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const fixtures = usePipelineFixtures(page);
  await page.goto("/projects");

  expect(await cardOrder(page)).toEqual(["Sand Hollow", "Pecan Valley", "Black Desert"]);

  // Move the third job to the top with the button, not a drag: a drag needs a
  // mouse and this list is read on a phone in gloves.
  const black = page.locator("a.project-card").filter({ hasText: "Black Desert" });
  await black.getByRole("button", { name: /move up/i }).click();
  await black.getByRole("button", { name: /move up/i }).click();

  await expect
    .poll(() => cardOrder(page))
    .toEqual(["Black Desert", "Sand Hollow", "Pecan Valley"]);

  // The WHOLE list went over, in its new order — that is what makes two
  // foremen saving at once land as one coherent order rather than interleaving.
  const saves = fixtures.calls.filter((c) => c.fn === "set_projects_order");
  expect(saves.length).toBeGreaterThan(0);
  expect((saves[saves.length - 1].body as { p_ids: string[] }).p_ids).toEqual([
    LATE_ID,
    NOT_READY_ID,
    FINE_ID,
  ]);

  // THE POINT: a full reload re-reads the server, and the order is still there.
  // An order that lived only in React state would fail here.
  await page.reload();
  await expect
    .poll(() => cardOrder(page))
    .toEqual(["Black Desert", "Sand Hollow", "Pecan Valley"]);
});

test("an installer never gets the reorder buttons", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  usePipelineFixtures(page);
  await page.goto("/projects");

  await expect(page.locator("a.project-card").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /move up/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /move down/i })).toHaveCount(0);
});

test("a foreman marks the windows arrived in one tap from the job's Overview", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const fixtures = usePipelineFixtures(page);
  await page.goto(`/projects/${NOT_READY_ID}`);

  const card = page.locator("section.detail-card").filter({ hasText: "Pipeline" }).first();
  await expect(card).toBeVisible();
  // The wave H seam is on screen and honest about knowing nothing yet.
  await expect(card.getByText(/None yet/i)).toBeVisible();

  await card.getByRole("button", { name: /^Materials arrived$/i }).click();

  await expect
    .poll(() => fixtures.calls.filter((c) => c.fn === "set_project_materials").length)
    .toBeGreaterThan(0);
  const body = fixtures.calls.find((c) => c.fn === "set_project_materials")
    ?.body as Record<string, unknown>;
  expect(body.p_arrived).toBe(true);
  // The one-tap call must NOT carry an ETA, or pressing it would wipe the date.
  expect(body.p_materials_eta).toBeNull();
  expect(body.p_clear_eta).toBe(false);
});

test("changing Expected start does not blank the job's address, customer or notes", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const fixtures = usePipelineFixtures(page);
  await page.goto(`/projects/${NOT_READY_ID}`);

  const card = page.locator("section.detail-card").filter({ hasText: "Pipeline" }).first();
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: /^Change$/ }).first().click();
  await card.getByLabel("Expected start").fill("2026-09-22");
  await card.getByRole("button", { name: /^Save$/ }).click();

  await expect
    .poll(() => fixtures.calls.filter((c) => c.fn === "PATCH projects").length)
    .toBeGreaterThan(0);

  const body = fixtures.calls.find((c) => c.fn === "PATCH projects")?.body as Record<
    string,
    unknown
  >;
  // THE POINT: one column. Not nine, eight of them nulled because this card has
  // no address box to have read them from.
  expect(body).toEqual({ start_date: "2026-09-22" });
});

test("an installer reads the Pipeline card but cannot change it", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  usePipelineFixtures(page);
  await page.goto(`/projects/${NOT_READY_ID}`);

  const card = page.locator("section.detail-card").filter({ hasText: "Pipeline" }).first();
  // Knowing there is no glass on site is exactly what an installer needs before
  // driving out, so the card is not role-gated — only its buttons are.
  await expect(card).toBeVisible();
  await expect(card.getByText(/Not ready/i).first()).toBeVisible();
  await expect(card.getByRole("button", { name: /Materials arrived/i })).toHaveCount(0);
  await expect(card.getByRole("button", { name: /Mark ready/i })).toHaveCount(0);
});

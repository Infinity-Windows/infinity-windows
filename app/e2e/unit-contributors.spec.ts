// Foreman unit contributors (2026-09-30) on the new Work front door: the
// compact action below the lead row. record_stage_contributors/
// correct_stage_contributors are replayed from an in-memory fixture, the
// same pattern crew-unit-records.spec.ts uses for the classic route.

import { expect, test, type Page } from "@playwright/test";
import { BLACK22, OAKRIDGE } from "./support/release1Fixtures";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures } from "./support/release1Fixtures";

test.setTimeout(60000);

const FOREMAN_ID = TEST_USER.id;
const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-00000000b0b1";
const OPENING = "00000000-0000-4000-8000-000000000019";
const MAPPED_UNIT = "00000000-0000-4000-8000-000000000020";
const UNIT = "00000000-0000-4000-8000-00000000001e";

interface ContribPerson {
  profile_id: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}
interface ContribRecord {
  id: string;
  project_id: string;
  unit_id: string;
  filed_by: string;
  stage: string;
  work_date: string;
  outcome: string;
  description: string;
  whole_complete: boolean;
  created_at: string;
  people: ContribPerson[];
}
interface HistoryRow {
  id: number;
  project_id: string;
  actor_id: string;
  entity_id: string;
  action: string;
  reason: string;
  before_value: unknown;
  after_value: unknown;
  created_at: string;
}

function digestFor(records: ContribRecord[], unitId: string, stage: string, workDate: string): string {
  const evidence = records
    .filter((r) => r.unit_id === unitId && r.stage === stage && r.work_date === workDate && (r.outcome === "partial" || r.outcome === "finished"))
    .flatMap((r) => r.people.filter((p) => !p.voided_at).map((p) => `${r.id}:${p.profile_id}`));
  return `digest:${[...new Set(evidence)].sort().join(",")}`;
}

async function useContributorFixtures(page: Page, opts: { role?: "foreman" | "installer"; openShift?: boolean; language?: "en" | "es" } = {}) {
  await useSupabaseFixtures(page, { role: opts.role ?? "foreman", uiDesign: "new", language: opts.language });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, openShift: opts.openShift ?? false, scheduleRows: [] });

  const records: ContribRecord[] = [];
  const history: HistoryRow[] = [];
  let historyId = 1;
  const units = [
    {
      id: UNIT,
      project_id: OAKRIDGE,
      opening_id: null as string | null,
      created_by: FOREMAN_ID,
      label: "Unit 16",
      type_label: "Bifold door",
      facts: {},
      legacy_time_present: false,
      untimed_work_present: false,
      revision: 1,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
    },
  ];
  const rpcCalls: { fn: string; body: Record<string, unknown> }[] = [];
  let offline = false;
  let loseResponse = false;

  await page.route("**/rest/v1/profiles**", (r) => {
    const url = new URL(r.request().url());
    if (!(url.searchParams.get("select") ?? "").includes("is_partner")) return r.fallback();
    return json(
      r,
      [
        { id: ALICE, display_name: "Alice Installer", active: true, role: "installer", is_partner: false },
        { id: BOB, display_name: "Bob Installer", active: true, role: "installer", is_partner: false },
        { id: FOREMAN_ID, display_name: "E2E Fixture", role: "foreman", active: true, is_partner: false },
      ],
      3,
    );
  });
  await page.route("**/rest/v1/project_openings**", (r) => json(r, [{ id: OPENING, project_id: OAKRIDGE, opening_code: "Map 19", status: "planned", removed_at: null }], 1));
  await page.route("**/rest/v1/custom_work_units**", (r) => json(r, units, units.length));
  await page.route("**/rest/v1/custom_work_history**", (r) => json(r, history, history.length));
  await page.route("**/rest/v1/crew_work_records**", (r) => json(r, records, records.length));

  await page.route((url) => /\/rest\/v1\/rpc\/record_stage_contributors(\?|$)/.test(url.href), (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    rpcCalls.push({ fn: "record_stage_contributors", body });
    if (offline) return r.abort("internetdisconnected");
    const data = body.p_data as Record<string, unknown>;
    const stage = String(data.stage), workDate = String(data.work_date), unitId = data.opening_id ? MAPPED_UNIT : String(data.unit_id);
    if (data.opening_id && !units.some((u) => u.id === MAPPED_UNIT)) {
      units.push({ ...units[0], id: MAPPED_UNIT, opening_id: String(data.opening_id), label: "Map 19" });
    }
    const requested = data.people as string[];
    if (!records.some((x) => x.id === body.p_id)) {
      const effective = new Set(
        records
          .filter((x) => x.unit_id === unitId && x.stage === stage && x.work_date === workDate && (x.outcome === "partial" || x.outcome === "finished"))
          .flatMap((x) => x.people.filter((p) => !p.voided_at).map((p) => p.profile_id)),
      );
      const fresh = requested.filter((p) => !effective.has(p));
      if (fresh.length) {
        records.push({
          id: String(body.p_id), project_id: OAKRIDGE, unit_id: unitId, filed_by: FOREMAN_ID, stage, work_date: workDate,
          outcome: String(data.outcome), description: String(data.description ?? ""), whole_complete: false,
          created_at: new Date().toISOString(), people: fresh.map((profile_id) => ({ profile_id, voided_at: null, voided_by: null, void_reason: null })),
        });
        history.push({ id: historyId++, project_id: OAKRIDGE, actor_id: FOREMAN_ID, entity_id: unitId, action: "stage_contributors", reason: "", before_value: null, after_value: { stage, work_date: workDate }, created_at: new Date().toISOString() });
      }
    }
    if (loseResponse) { loseResponse = false; return r.abort("failed"); }
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(unitId) });
  });
  await page.route((url) => /\/rest\/v1\/rpc\/stage_contributor_summary(\?|$)/.test(url.href), (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const unitId = String(body.p_unit);
    const rows = records
      .filter((x) => x.unit_id === unitId && (x.outcome === "partial" || x.outcome === "finished"))
      .flatMap((x) => x.people.filter((p) => !p.voided_at).map((p) => ({ stage: x.stage, work_date: x.work_date, profile_id: p.profile_id })));
    const distinct = [...new Map(rows.map((x) => [`${x.stage}|${x.work_date}|${x.profile_id}`, x])).values()];
    const out = distinct.map((x) => ({ ...x, digest: digestFor(records, unitId, x.stage, x.work_date) }));
    return json(r, out, out.length);
  });
  await page.route((url) => /\/rest\/v1\/rpc\/correct_stage_contributors(\?|$)/.test(url.href), (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    rpcCalls.push({ fn: "correct_stage_contributors", body });
    const data = body.p_data as Record<string, unknown>;
    const unitId = String(data.unit_id), stage = String(data.stage), workDate = String(data.work_date);
    const expected = digestFor(records, unitId, stage, workDate);
    if (data.expected_digest !== expected) {
      return r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "This contributor summary changed since you loaded it." }) });
    }
    const remove = (data.remove as string[]) ?? [];
    const add = (data.add as string[]) ?? [];
    for (const rec of records) {
      if (rec.unit_id !== unitId || rec.stage !== stage || rec.work_date !== workDate) continue;
      for (const p of rec.people) if (remove.includes(p.profile_id) && !p.voided_at) { p.voided_at = new Date().toISOString(); p.voided_by = FOREMAN_ID; p.void_reason = String(data.reason); }
    }
    if (add.length) {
      records.push({
        id: String(body.p_id), project_id: OAKRIDGE, unit_id: unitId, filed_by: FOREMAN_ID, stage, work_date: workDate,
        outcome: String(data.outcome ?? "finished"), description: "", whole_complete: false,
        created_at: new Date().toISOString(), people: add.map((profile_id) => ({ profile_id, voided_at: null, voided_by: null, void_reason: null })),
      });
    }
    history.push({ id: historyId++, project_id: OAKRIDGE, actor_id: FOREMAN_ID, entity_id: unitId, action: "stage_contributor_correction", reason: String(data.reason), before_value: { stage, work_date: workDate }, after_value: { stage, work_date: workDate }, created_at: new Date().toISOString() });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(unitId) });
  });

  const otherMutations: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /custom_work_command|clock_in|finish_unit|record_qc_decision/.test(r.url())) otherMutations.push(r.url()); });

  return { records, history, rpcCalls, otherMutations, setOffline: (v: boolean) => { offline = v; }, loseNextResponse: () => { loseResponse = true; } };
}

async function openPanel(page: Page) {
  await page.getByTestId("ws-contrib-open").click();
  const panel = page.getByRole("dialog", { name: "Unit contributors" });
  await expect(panel).toBeVisible();
  return panel;
}

test.use({ viewport: { width: 375, height: 667 } });

test("a current shift defaults the job but allows an earlier job to be chosen", async ({ page }) => {
  await useContributorFixtures(page, { openShift: true });
  await page.goto("/");
  const panel = await openPanel(page);
  const jobs = panel.getByLabel("Job", { exact: true });
  await expect(jobs).toHaveValue(OAKRIDGE);
  await expect(jobs).toBeEnabled();
  await jobs.selectOption(BLACK22);
  await expect(jobs).toHaveValue(BLACK22);
  await expect(panel.getByLabel("Unit or map opening")).toHaveValue("");
});

test("an unavailable summary is explained and cannot be mistaken for empty history", async ({ page }) => {
  const state = await useContributorFixtures(page);
  await page.route("**/rpc/stage_contributor_summary", (route) => route.fulfill({ status: 404, json: { code: "PGRST202", message: "function does not exist" } }));
  await page.goto("/");
  const panel = await openPanel(page);
  await panel.getByLabel("Job").selectOption(OAKRIDGE);
  await panel.getByLabel("Unit or map opening").selectOption(UNIT);
  await expect(panel.getByRole("alert")).toContainText("not available yet");
  await expect(panel.getByRole("button", { name: "Save contributors" })).toBeDisabled();
  expect(state.rpcCalls).toEqual([]);
});

test("foreman: two installers' flashing from yesterday, off the clock, on a job picked in the panel", async ({ page }) => {
  const state = await useContributorFixtures(page, { openShift: false });
  await page.goto("/");
  const panel = await openPanel(page);
  await panel.getByLabel("Job").selectOption(OAKRIDGE);
  await panel.getByLabel("Unit or map opening").selectOption(UNIT);
  await panel.getByRole("button", { name: "Flashing", exact: true }).click();
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  await panel.getByLabel("Work date").fill(yesterday);
  for (const name of ["Alice Installer", "Bob Installer"]) await panel.getByRole("button", { name, exact: true }).click();
  await expect(panel.getByText("2 selected")).toBeVisible();
  // No timer, no whole-unit-completion input anywhere in this form.
  await expect(panel.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(panel).not.toContainText(/entire installation/i);
  await page.screenshot({ path: "e2e/test-results/unit-contributors-phone.png", fullPage: true });

  await panel.getByRole("button", { name: "Save contributors" }).click();
  await expect.poll(() => state.rpcCalls.filter((c) => c.fn === "record_stage_contributors").length).toBe(1);
  const sent = state.rpcCalls[0].body.p_data as Record<string, unknown>;
  expect(sent.people).toEqual([ALICE, BOB]);
  expect(sent.stage).toBe("Flashing");
  expect(sent.work_date).toBe(yesterday);
  expect(sent.outcome).toBe("finished");
  expect(sent).not.toHaveProperty("whole_complete");
  expect(state.otherMutations).toEqual([]);
  await expect(panel.getByText("Contributors confirmed in Forge.")).toBeVisible();
  await panel.locator("ul.ws-list").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e/test-results/unit-contributors-phone-confirmed.png" });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "e2e/test-results/unit-contributors-desktop.png", fullPage: true });
});

test("a mapped opening creates a companion and immediately shows confirmed contributors and corrections", async ({ page }) => {
  const state = await useContributorFixtures(page);
  await page.goto("/");
  const panel = await openPanel(page);
  await panel.getByLabel("Job").selectOption(OAKRIDGE);
  await panel.getByLabel("Unit or map opening").selectOption(`map:${OPENING}`);
  await panel.getByRole("button", { name: "Alice Installer", exact: true }).click();
  await panel.getByRole("button", { name: "Save contributors" }).click();
  await expect(panel.getByText("Contributors confirmed in Forge.")).toBeVisible();
  await expect(panel.locator("ul.ws-list").getByText("Alice Installer")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Correct this" })).toBeVisible();
  await expect(panel.getByLabel("Unit or map opening")).toHaveValue(`map:${OPENING}`);
  expect(state.records).toHaveLength(1);
  expect(state.records[0].unit_id).toBe(MAPPED_UNIT);
  expect((state.rpcCalls[0].body.p_data as Record<string, unknown>).opening_id).toBe(OPENING);
  expect(state.otherMutations).toEqual([]);
});

test("a lost server response retries the original request without duplicating the saved report", async ({ page }) => {
  const state = await useContributorFixtures(page);
  await page.goto("/");
  const panel = await openPanel(page);
  await panel.getByLabel("Job").selectOption(OAKRIDGE);
  await panel.getByLabel("Unit or map opening").selectOption(UNIT);
  await panel.getByRole("button", { name: "Alice Installer", exact: true }).click();
  state.loseNextResponse();
  await panel.getByRole("button", { name: "Save contributors" }).click();
  await expect.poll(() => state.records.length).toBe(1);
  await expect(panel.getByText(/awaiting sync/)).toBeVisible();
  const original = state.rpcCalls[0].body.p_id;
  await panel.getByRole("button", { name: "Retry saved work" }).click();
  await expect.poll(() => state.rpcCalls.length).toBe(2);
  expect(state.rpcCalls[1].body.p_id).toBe(original);
  expect(state.records).toHaveLength(1);
  await expect(panel.getByText("Contributors confirmed in Forge.")).toBeVisible();
  expect(state.otherMutations).toEqual([]);
});

test("a queued record is distinct from a saved one and survives reload with the same request id", async ({ page }) => {
  const state = await useContributorFixtures(page);
  await page.goto("/");
  const panel = await openPanel(page);
  await panel.getByLabel("Job").selectOption(OAKRIDGE);
  await panel.getByLabel("Unit or map opening").selectOption(UNIT);
  await panel.getByRole("button", { name: "Alice Installer", exact: true }).click();
  state.setOffline(true);
  await panel.getByRole("button", { name: "Save contributors" }).click();
  await expect(panel.getByText(/awaiting sync/)).toBeVisible();
  await expect.poll(() => state.rpcCalls.length).toBeGreaterThan(0);
  const firstId = state.rpcCalls[0].body.p_id;
  state.setOffline(false);
  await page.reload();
  await expect.poll(() => state.records.length).toBe(1);
  expect(state.rpcCalls.every((c) => c.body.p_id === firstId)).toBe(true);
  expect(state.otherMutations).toEqual([]);
});

test("an installer reads the summary with no write controls", async ({ page }) => {
  const state = await useContributorFixtures(page, { role: "installer" });
  state.records.push({
    id: "seed-1", project_id: OAKRIDGE, unit_id: UNIT, filed_by: FOREMAN_ID, stage: "RO checked",
    work_date: "2026-09-29", outcome: "finished", description: "", whole_complete: false, created_at: "2026-09-29T12:00:00Z",
    people: [{ profile_id: ALICE, voided_at: null, voided_by: null, void_reason: null }],
  });
  await page.goto("/");
  await expect(page.getByTestId("ws-contrib-open")).toHaveText("View contributors");
  const panel = await openPanel(page);
  await panel.getByLabel("Job").selectOption(OAKRIDGE);
  await panel.getByLabel("Unit or map opening").selectOption(UNIT);
  await panel.getByLabel("Work date").fill("2026-09-29");
  await expect(panel.locator("ul.ws-list").getByText("Alice Installer")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Save contributors" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Correct this" })).toHaveCount(0);
});

test("a correction records a reason and shows in history; removing one of two leaves the other", async ({ page }) => {
  const state = await useContributorFixtures(page);
  state.records.push({
    id: "seed-2", project_id: OAKRIDGE, unit_id: UNIT, filed_by: FOREMAN_ID, stage: "RO checked",
    work_date: "2026-09-29", outcome: "finished", description: "", whole_complete: false, created_at: "2026-09-29T12:00:00Z",
    people: [
      { profile_id: ALICE, voided_at: null, voided_by: null, void_reason: null },
      { profile_id: BOB, voided_at: null, voided_by: null, void_reason: null },
    ],
  });
  await page.goto("/");
  const panel = await openPanel(page);
  await panel.getByLabel("Job").selectOption(OAKRIDGE);
  await panel.getByLabel("Unit or map opening").selectOption(UNIT);
  await panel.getByLabel("Work date").fill("2026-09-29");
  // "Currently credited" is the summary list, not the record form's own crew
  // picker below it (which lists everyone, including already-credited people,
  // for a fresh record) — scope to the list so these checks aren't fooled by it.
  const credited = panel.locator("ul.ws-list");
  await expect(credited.getByText("Alice Installer")).toBeVisible();
  await expect(credited.getByText("Bob Installer")).toBeVisible();

  await panel.getByRole("button", { name: "Correct this" }).click();
  // Alice is already an effective contributor, so she appears once here —
  // the "Remove" chip row (the record form is hidden while correcting).
  await panel.getByRole("button", { name: "Alice Installer", exact: true }).click();
  await panel.getByLabel("Reason for this correction").fill("Alice left the site before flashing finished");
  await panel.getByRole("button", { name: "Save correction" }).click();
  await expect.poll(() => state.rpcCalls.filter((c) => c.fn === "correct_stage_contributors").length).toBe(1);

  await expect(credited.getByText("Bob Installer")).toBeVisible();
  await expect(credited.getByText("Alice Installer")).toHaveCount(0);
  await panel.getByText("History").click();
  await expect(panel).toContainText("Alice left the site before flashing finished");
  await expect(panel).toContainText("Corrected by");
});

test("Spanish: the compact action reads in Spanish, including the stage/people form once a unit is chosen", async ({ page }) => {
  await useContributorFixtures(page, { language: "es" });
  await page.goto("/");
  await expect(page.getByTestId("ws-contrib-open")).toContainText("Agregar colaboradores");
  await page.getByTestId("ws-contrib-open").click();
  const panel = page.getByRole("dialog", { name: "Colaboradores de la unidad" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Unidad o apertura del mapa");
  await panel.getByLabel("Trabajo").selectOption(OAKRIDGE);
  await panel.getByLabel("Unidad o apertura del mapa").selectOption(UNIT);
  await expect(panel).toContainText("¿Quién la trabajó?");
  await expect(panel.getByRole("button", { name: "Impermeabilización", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Guardar colaboradores" })).toBeVisible();
});

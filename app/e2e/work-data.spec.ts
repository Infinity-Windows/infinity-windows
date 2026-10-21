/// <reference types="vite/client" />
// Work Data is a private, read-only reconciliation view. Every response below
// is synthetic and intercepted before it can reach Supabase.
import { expect, test, type Page } from "@playwright/test";
import type { WorkDataSnapshot } from "../src/lib/workData/api";
import { FIXTURE_AUTH_KEY, TEST_USER, jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const JOB = jobFixtures().find((j) => j.jobCode === "OAKRIDGE")!;
const PROFILE = "e2e-work-data-person-1";
const HELPER = "e2e-work-data-person-2";
const UNIT = "e2e-work-data-unit-1";
const PRIVATE_MARKER = "fixture-private-work-data-marker";

const snapshot: WorkDataSnapshot = {
  schemaVersion: 1,
  asOf: "2026-10-02T23:59:00.000Z",
  project: { id: JOB.projectId, jobCode: JOB.jobCode, name: "Oakridge Apartments Bldg C" },
  shifts: [
    {
      id: "shift-classified-and-conflicted",
      profileId: PROFILE,
      projectId: JOB.projectId,
      startedAt: "2026-10-02T08:00:00.000Z",
      endedAt: "2026-10-02T12:00:00.000Z",
      breakSeconds: 0,
      breakStartedAt: null,
      status: "approved",
      profileName: "Riley Fixture",
      reviewReason: null,
    },
    {
      id: "shift-historical-break-position-unknown",
      profileId: PROFILE,
      projectId: JOB.projectId,
      startedAt: "2026-10-02T13:00:00.000Z",
      endedAt: "2026-10-02T16:00:00.000Z",
      breakSeconds: 1800,
      breakStartedAt: null,
      status: "approved",
      profileName: "Riley Fixture",
      reviewReason: null,
    },
    {
      id: "shift-helper",
      profileId: HELPER,
      projectId: JOB.projectId,
      startedAt: "2026-10-02T08:00:00.000Z",
      endedAt: "2026-10-02T09:00:00.000Z",
      breakSeconds: 0,
      breakStartedAt: null,
      status: "approved",
      profileName: "Jordan Fixture",
      reviewReason: null,
    },
  ],
  claims: [
    {
      sourceId: "claim-general",
      sourceTable: "crew_work_records",
      revision: 1,
      profileId: PROFILE,
      projectId: JOB.projectId,
      shiftId: "shift-classified-and-conflicted",
      unitId: null,
      activityId: "general",
      label: "Site setup",
      scope: "general",
      startedAt: "2026-10-02T08:00:00.000Z",
      endedAt: "2026-10-02T09:00:00.000Z",
    },
    {
      sourceId: "claim-unit-primary",
      sourceTable: "crew_work_records",
      revision: 1,
      profileId: PROFILE,
      projectId: JOB.projectId,
      shiftId: "shift-classified-and-conflicted",
      unitId: UNIT,
      activityId: "install",
      label: `Install W7 · ${PRIVATE_MARKER}`,
      scope: "specific",
      startedAt: "2026-10-02T09:00:00.000Z",
      endedAt: "2026-10-02T10:00:00.000Z",
    },
    {
      sourceId: "claim-overlap-a",
      sourceTable: "crew_work_records",
      revision: 1,
      profileId: PROFILE,
      projectId: JOB.projectId,
      shiftId: "shift-classified-and-conflicted",
      unitId: null,
      activityId: "other-a",
      label: "Conflicting activity A",
      scope: "other",
      startedAt: "2026-10-02T10:00:00.000Z",
      endedAt: "2026-10-02T10:30:00.000Z",
    },
    {
      sourceId: "claim-overlap-b",
      sourceTable: "crew_work_records",
      revision: 1,
      profileId: PROFILE,
      projectId: JOB.projectId,
      shiftId: "shift-classified-and-conflicted",
      unitId: null,
      activityId: "other-b",
      label: "Conflicting activity B",
      scope: "other",
      startedAt: "2026-10-02T10:15:00.000Z",
      endedAt: "2026-10-02T10:45:00.000Z",
    },
    {
      sourceId: "claim-unit-helper",
      sourceTable: "crew_work_records",
      revision: 1,
      profileId: HELPER,
      projectId: JOB.projectId,
      shiftId: "shift-helper",
      unitId: UNIT,
      activityId: "install",
      label: "Install W7 by helper",
      scope: "specific",
      startedAt: "2026-10-02T08:00:00.000Z",
      endedAt: "2026-10-02T09:00:00.000Z",
    },
  ],
  units: [
    {
      id: UNIT,
      label: "W7",
      category: "Window",
      subtype: "Fixed",
      material: "Aluminum",
      floor: "1",
      widthIn: 48,
      heightIn: 36,
      dimensionSource: "fixture plan",
      dimensionsVerified: true,
      complete: true,
      qcAccepted: true,
      hasUntimedEvidence: false,
    },
    {
      id: "e2e-work-data-unit-untimed",
      label: "W8",
      category: "Window",
      subtype: null,
      material: null,
      floor: "1",
      widthIn: 48,
      heightIn: 36,
      dimensionSource: "fixture plan",
      dimensionsVerified: true,
      complete: true,
      qcAccepted: true,
      hasUntimedEvidence: true,
    },
  ],
  untimed: [
    {
      sourceId: "untimed-stage-source",
      sourceTable: "opening_phases",
      profileId: null,
      projectId: JOB.projectId,
      unitId: "e2e-work-data-unit-untimed",
      activityId: "legacy-install",
      label: "Older stage minutes",
      workDate: "2026-10-02",
      reportedSeconds: 900,
    },
  ],
};

type SnapshotRequest = { p_project_id: string; p_from: string; p_until: string };

async function mockWorkDataSnapshot(page: Page, report = snapshot) {
  const calls: SnapshotRequest[] = [];
  await page.route("**/rest/v1/rpc/work_data_snapshot", async (route) => {
    calls.push(route.request().postDataJSON() as SnapshotRequest);
    await json(route, report, null);
  });
  return calls;
}

async function loadReport(page: Page, peopleHeading = "People and payroll sources") {
  await page.goto("/data");
  const jobs = page.getByRole("combobox").first();
  await expect(jobs).toContainText("OAKRIDGE · Oakridge Apartments Bldg C");
  await jobs.selectOption({ label: "OAKRIDGE · Oakridge Apartments Bldg C" });
  await expect(page.getByText(peopleHeading, { exact: true })).toBeVisible();
}

for (const role of ["supervisor", "owner"] as const) {
  test(`${role} can load a fixture snapshot and see payroll reconciliation and source details`, async ({ page }) => {
    await useSupabaseFixtures(page, { role, uiDesign: "new" });
    await hideWrongProjectBanner(page);
    const calls = await mockWorkDataSnapshot(page);
    await loadReport(page);

    await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Summary", exact: true })).toHaveAttribute("href", "/summary");
    await expect(page.getByText("Recorded payroll", { exact: true })).toBeVisible();
    await expect(page.getByText("Classified", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Unknown", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Conflicted", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Riley Fixture", { exact: false }).first()).toBeVisible();

    const historicalBreak = page.locator(".work-data-card").filter({ hasText: "shift-historical-break-position-unknown" }).first();
    await historicalBreak.locator("summary").click();
    await expect(page.getByText("Historical break position unknown", { exact: true })).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0].p_project_id).toBe(JOB.projectId);
    expect(Date.parse(calls[0].p_from)).toBeLessThan(Date.parse(calls[0].p_until));
    expect(calls[0].p_until).toContain("T");

    const unitCard = page.locator(".work-data-card").filter({ hasText: "W7" }).first();
    await expect(unitCard).toContainText("12.00 ft²");
    // Two people claim labor for W7, but it remains one canonical unit row.
    await expect(page.locator(".work-data-card summary").filter({ hasText: "W7" })).toHaveCount(1);
    await page.getByText("Recorded area by floor", { exact: true }).click();
    await expect(page.getByText("1: 24.00 ft²", { exact: true })).toBeVisible();
    const untimedUnit = page.locator(".work-data-card").filter({ hasText: "W8" }).first();
    await untimedUnit.locator("summary").click();
    await expect(untimedUnit).toContainText("Untimed evidence");
    await expect(page.getByText("Historical break position unknown", { exact: true })).toBeVisible();
    await page.getByText("Original activity sources", { exact: false }).click();
    await expect(page.locator(".work-data-source").getByText("claim-unit-primary", { exact: true })).toBeVisible();
    await expect(page.getByText(PRIVATE_MARKER, { exact: false }).first()).toBeVisible();
  });
}

test("Spanish labels come from the signed-in profile language", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor", language: "es", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await mockWorkDataSnapshot(page);
  await loadReport(page, "Personas y fuentes de nómina");
  await expect(page.getByRole("heading", { name: "Datos", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Resumen", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Obra", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Fecha inicial", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Fecha final", exact: true })).toBeVisible();
  await expect(page.getByText("Nómina registrada", { exact: true })).toBeVisible();
});

for (const role of ["installer", "foreman"] as const) {
  test(`${role} cannot fetch or see a Work Data snapshot`, async ({ page }) => {
    await useSupabaseFixtures(page, { role, uiDesign: "new" });
    await hideWrongProjectBanner(page);
    const calls = await mockWorkDataSnapshot(page);
    await page.goto("/data");
    await expect(page.getByText("Not available for your role", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Riley Fixture" })).toHaveCount(0);
    expect(calls).toEqual([]);
  });
}

test("a partner is redirected before the Work Data route can fetch private evidence", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  const calls = await mockWorkDataSnapshot(page);
  await page.route("**/rest/v1/rpc/is_partner_user", (route) => json(route, true, null));
  await page.goto("/data");
  await expect(page).toHaveURL(/\/stg\/?$/);
  expect(calls).toEqual([]);
});

test("Classic /data remains the existing DataHub", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor", uiDesign: "classic" });
  await hideWrongProjectBanner(page);
  let snapshotCalls = 0;
  await page.route("**/rest/v1/rpc/work_data_snapshot", (route) => { snapshotCalls++; return json(route, snapshot, null); });
  await page.goto("/data");
  await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible();
  await expect(page.getByText("Follow recorded payroll back to its work evidence.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Summary", exact: true })).toHaveCount(0);
  expect(snapshotCalls).toBe(0);
});

test("private evidence disappears on role preview or offline reload and is not persisted to browser storage", async ({ page, context }) => {
  await useSupabaseFixtures(page, { role: "owner", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  const calls = await mockWorkDataSnapshot(page);
  await loadReport(page);
  await page.getByText("Original activity sources", { exact: false }).click();
  await expect(page.getByText(PRIVATE_MARKER, { exact: false }).first()).toBeVisible();

  const stored = await page.evaluate(() => {
    const entries = (storage: Storage) => Array.from({ length: storage.length }, (_, i) => {
      const key = storage.key(i)!;
      return [key, storage.getItem(key)];
    });
    return JSON.stringify({ local: entries(localStorage), session: entries(sessionStorage) });
  });
  expect(stored).not.toContain(PRIVATE_MARKER);
  expect(stored).not.toContain("claim-unit-primary");

  await page.evaluate(() => sessionStorage.setItem("infinity.viewAsRole", "installer"));
  await page.reload();
  await expect(page.getByText("Not available for your role", { exact: true })).toBeVisible();
  await expect(page.getByText(PRIVATE_MARKER, { exact: false })).toHaveCount(0);
  expect(calls).toHaveLength(1);

  // Return as the owner and refetch, then switch the browser offline. The
  // offline state must replace the private report, not reveal a cached copy.
  await page.evaluate(() => sessionStorage.removeItem("infinity.viewAsRole"));
  await page.reload();
  await loadReport(page);
  await expect(page.getByText(PRIVATE_MARKER, { exact: false }).first()).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText("Reconnect to view private work evidence.", { exact: true })).toBeVisible();
  await expect(page.getByText(PRIVATE_MARKER, { exact: false })).toHaveCount(0);
  expect(calls).toHaveLength(2);
  await context.setOffline(false);
});

test("the layout stays within narrow portrait and landscape viewports", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await mockWorkDataSnapshot(page);
  await loadReport(page);
  for (const viewport of [
    { width: 320, height: 720 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => ({
      width: window.innerWidth,
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      outside: Array.from(document.querySelectorAll<HTMLElement>(".work-data *"))
        .filter(el => el.getClientRects().length && el.getBoundingClientRect().right > window.innerWidth)
        .map(el => `${el.tagName}.${el.className}: ${Math.round(el.getBoundingClientRect().right)}`),
    }))).toEqual({ width: viewport.width, overflow: 0, outside: [] });
  }
});

test("changing the signed-in profile below supervisor hides the previous snapshot", async ({ page }) => {
  let role: "supervisor" | "foreman" = "supervisor";
  const calls = await useSupabaseFixtures(page, {
    role: "supervisor",
    uiDesign: "new",
    profileOverrides: () => ({ role }),
  });
  await hideWrongProjectBanner(page);
  let snapshotCalls = 0;
  await page.route("**/rest/v1/rpc/work_data_snapshot", (route) => { snapshotCalls++; return json(route, snapshot, null); });
  await loadReport(page);
  await expect(page.getByText("People and payroll sources", { exact: true })).toBeVisible();
  expect(snapshotCalls).toBe(1);

  role = "foreman";
  await page.reload();
  await expect(page.getByText("Not available for your role", { exact: true })).toBeVisible();
  await expect(page.getByText("Riley Fixture", { exact: false })).toHaveCount(0);
  expect(snapshotCalls).toBe(1);
  void calls;
});

test("switching the authenticated identity clears the previous person's snapshot", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor", uiDesign: "new", session: "phone" });
  await hideWrongProjectBanner(page);
  const calls = await mockWorkDataSnapshot(page);
  await loadReport(page);
  await expect(page.getByText("People and payroll sources", { exact: true })).toBeVisible();
  expect(calls).toHaveLength(1);

  const switchedUser = { ...TEST_USER, id: "00000000-0000-4000-8000-0000000000e3" };
  await page.route("**/auth/v1/user", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(switchedUser),
  }));
  await page.evaluate(({ authKey, userId }) => {
    const session = JSON.parse(localStorage.getItem(authKey)!);
    session.user.id = userId;
    localStorage.setItem(authKey, JSON.stringify(session));
  }, { authKey: FIXTURE_AUTH_KEY, userId: switchedUser.id });
  await page.reload();
  await expect(page.getByText("Not available for your role", { exact: true })).toBeVisible();
  await expect(page.getByText("Riley Fixture", { exact: false })).toHaveCount(0);
  expect(calls).toHaveLength(1);
});

function explorationSnapshot(): WorkDataSnapshot {
  const report = structuredClone(snapshot);
  for (const [id, person, floor, category, subtype, width, hours] of [
    ["door-unit", "door-person", "2", "Door", "Bifold", 96, 2],
    ["unknown-unit", "unknown-person", null, null, null, null, 1],
  ] as const) {
    const shiftId = `${id}-shift`;
    report.units.push({ ...report.units[0], id, label: id, category, subtype, floor,
      widthIn: width, heightIn: width, dimensionSource: width === null ? "" : report.units[0].dimensionSource, dimensionsVerified: width !== null });
    report.shifts.push({ ...report.shifts[2], id: shiftId, profileId: person, profileName: person,
      startedAt: "2026-10-02T16:00:00.000Z", endedAt: `2026-10-02T${16 + hours}:00:00.000Z` });
    report.claims.push({ ...report.claims[1], sourceId: `${id}-source`, unitId: id,
      profileId: person, shiftId, label: "Setting / adjusting", activityId: "setting",
      startedAt: "2026-10-02T16:00:00.000Z", endedAt: `2026-10-02T${16 + hours}:00:00.000Z` });
  }
  return report;
}

test("unit filters drill down recorded facts without changing the job payroll or fetching again", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  const calls = await mockWorkDataSnapshot(page, explorationSnapshot());
  await loadReport(page);
  const explorer = page.locator(".work-data-explorer");
  const payroll = page.locator(".work-data-stats > div").filter({ hasText: "Recorded payroll" });
  await expect(payroll).toContainText("10.50 h");
  await explorer.getByRole("combobox", { name: "Category", exact: true }).selectOption({ label: "Door" });
  await expect(explorer.locator(".work-data-unit summary")).toHaveCount(1);
  await expect(explorer.locator(".work-data-unit summary")).toContainText("door-unit");
  await expect(explorer.getByText("2.00 h / 64.00 ft²", { exact: false })).toBeVisible();
  await expect(payroll).toContainText("10.50 h");
  await explorer.getByRole("combobox", { name: "Unit type", exact: true }).selectOption({ label: "Bifold" });
  await explorer.getByRole("combobox", { name: "Category", exact: true }).selectOption({ label: "Window" });
  await expect(explorer.getByRole("combobox", { name: "Unit type", exact: true })).toHaveValue("");
  await expect(explorer.locator(".work-data-unit summary")).toHaveCount(2);
  await explorer.getByRole("button", { name: "Clear unit filters" }).click();
  await explorer.getByRole("combobox", { name: "Floor / level", exact: true }).selectOption({ label: "Unknown" });
  await expect(explorer.locator(".work-data-unit summary")).toHaveCount(1);
  await expect(explorer.locator(".work-data-unit summary")).toContainText("unknown-unit");
  await expect(payroll).toContainText("10.50 h");
  expect(calls).toHaveLength(1);
});

test("size bounds are inclusive, unknown area is not zero, and invalid bounds show no unit totals", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await mockWorkDataSnapshot(page, explorationSnapshot());
  await loadReport(page);
  const explorer = page.locator(".work-data-explorer");
  await explorer.getByRole("spinbutton", { name: "Minimum area (sq ft)", exact: true }).fill("12");
  await explorer.getByRole("spinbutton", { name: "Maximum area (sq ft)", exact: true }).fill("12");
  await expect(explorer.locator(".work-data-unit summary")).toHaveCount(2);
  await explorer.getByRole("spinbutton", { name: "Minimum area (sq ft)", exact: true }).fill("20");
  await expect(explorer.getByRole("alert")).toContainText("valid area range");
  await expect(explorer.getByLabel("Selected unit totals")).toHaveCount(0);
  await explorer.getByRole("button", { name: "Clear unit filters" }).click();
  await explorer.getByRole("spinbutton", { name: "Minimum area (sq ft)", exact: true }).fill("0");
  await expect(explorer.locator(".work-data-unit summary")).toHaveCount(3);
});

test("unit activities keep helper labor and sources without double-counting area or exclusions", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await mockWorkDataSnapshot(page, explorationSnapshot());
  await loadReport(page);
  const explorer = page.locator(".work-data-explorer");
  const unit = explorer.locator(".work-data-unit").filter({ hasText: "W7" });
  await unit.locator("summary").click();
  await expect(unit).toContainText("claim-unit-primary");
  await expect(unit).toContainText("claim-unit-helper");
  await expect(unit.locator(".work-data-stage")).toHaveCount(2);
  await expect(unit.locator("summary")).toContainText("2.00 h · 12.00 ft²");
  const missing = explorer.locator(".work-data-unit").filter({ hasText: "unknown-unit" });
  await missing.locator("summary").click();
  await expect(missing.locator("dt").filter({ hasText: "Recorded dimension source" }).locator("..").locator("dd")).toHaveText("Unknown");
  await explorer.getByText("Why units are excluded", { exact: true }).click();
  await expect(explorer).toContainText("do not add their hours together");
  await explorer.getByText("Recorded area by floor", { exact: true }).click();
  await expect(explorer.getByRole("heading", { name: "2: 64.00 ft²", exact: true })).toBeVisible();
  await expect(explorer.getByRole("heading", { name: "Unknown: 0.00 ft²", exact: true })).toBeVisible();
});

test("actual unavailable taxonomy and QC stay unknown instead of producing a trusted average", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor", language: "es", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  const report = explorationSnapshot();
  report.units.forEach(unit => { unit.category = null; unit.subtype = null; unit.dimensionsVerified = false; unit.qcAccepted = false; });
  await mockWorkDataSnapshot(page, report);
  await loadReport(page, "Personas y fuentes de nómina");
  const explorer = page.locator(".work-data-explorer");
  await expect(explorer.getByRole("combobox", { name: "Categoría", exact: true }).locator("option")).toHaveText(["Todos", "Desconocido"]);
  await expect(explorer.getByText("Aún no hay un grupo elegible", { exact: true }).first()).toBeVisible();
  await expect(explorer).toContainText("clasificaciones faltantes");
  for (const viewport of [{width:320,height:720},{width:390,height:844},{width:844,height:390}]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => ({width:window.innerWidth,overflow:document.documentElement.scrollWidth-window.innerWidth})))
      .toEqual({width:viewport.width,overflow:0});
  }
});

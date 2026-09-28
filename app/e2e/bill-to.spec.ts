// Who a job bills to (20261035000000): the "Bills to" field on a job's GC card
// and the two columns it adds to the Job timecards file.
//
// Proved here, against the fixture server (never the shared database):
//   - a supervisor sees STG Windows and Doors, picks Strata, and the page sends
//     ONE set_project_bill_to with exactly that job and customer, then shows
//     who changed it;
//   - a foreman sees no field at all, and the app never even asks for it;
//   - the Job timecards file from a supervisor ends with exactly
//     "Time Zone,Bill To,Bill To QuickBooks ID", under the unchanged file name,
//     in both the custom-dates and the full-history exports;
//   - a foreman's file has neither column, and a foreman granted "Sees costs"
//     gets both.
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures as loadSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

test.use({ timezoneId: "America/Denver" });
test.setTimeout(60_000);

const id = (n: number) => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, "0")}`;
const JOB = id(10);
const STG = { id: id(30), name: "STG Windows and Doors", billing_email: null, quickbooks_customer_id: "4", is_default: true, retired_at: null };
const STRATA = { id: id(31), name: "Strata", billing_email: null, quickbooks_customer_id: null, is_default: false, retired_at: null };

type Role = "foreman" | "supervisor";

async function fixtures(page: Page, role: Role, canSeeCosts = false) {
  await page.clock.install({ time: new Date("2026-09-16T16:00:00Z") });
  await loadSupabaseFixtures(page, { role, canSeeCosts });
  await hideWrongProjectBanner(page);
  const me = { id: TEST_USER.id, display_name: "Fixture Supervisor", role, active: true, can_see_costs: canSeeCosts, can_see_pay: false, language: "en" };
  const projects = [{ id: JOB, job_code: "JOB-A", name: "River home", status: "active", is_test: false, allowed_modes: ["tracking"], job_kind: "residential" }];
  const shifts = [
    { id: id(100), profile_id: TEST_USER.id, project_id: JOB, clock_in_at: "2026-09-14T12:00:00Z", clock_out_at: "2026-09-14T20:00:00Z", status: "approved" },
  ].map(s => ({ ...s, break_seconds: 1800, break_started_at: null, cost_code_id: id(20), created_at: s.clock_in_at,
    profiles: { display_name: me.display_name }, projects: projects[0], cost_codes: { code: "1", label: "Installation" } }));

  const state = {
    current: STG as typeof STG | typeof STRATA,
    history: [] as unknown[],
    calls: [] as Record<string, unknown>[],
    reads: 0,
  };
  const row = () => ({
    project_id: JOB, bill_to_customer_id: state.current.id, updated_at: "2026-09-16T16:00:00Z",
    customer: { id: state.current.id, name: state.current.name, quickbooks_customer_id: state.current.quickbooks_customer_id, retired_at: null },
  });

  await page.route("**/rest/v1/profiles**", r => json(r, new URL(r.request().url()).searchParams.get("id") ? me : [me], 1));
  await page.route("**/rest/v1/projects**", r => json(r, projects, projects.length));
  await page.route("**/rest/v1/time_shifts**", r => {
    const p = new URL(r.request().url()).searchParams;
    if (p.get("clock_out_at") === "is.null") return json(r, [], 0);
    return json(r, shifts, shifts.length);
  });
  await page.route("**/rest/v1/bill_to_customers**", r => { state.reads++; return json(r, [STG, STRATA], 2); });
  await page.route("**/rest/v1/project_bill_to_history**", r => { state.reads++; return json(r, state.history, state.history.length); });
  await page.route("**/rest/v1/project_bill_to?**", r => {
    state.reads++;
    const single = (r.request().headers().accept ?? "").includes("pgrst.object");
    return json(r, single ? row() : [row()], 1);
  });
  await page.route("**/rest/v1/rpc/set_project_bill_to", r => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    state.calls.push(body);
    const previous = state.current;
    state.current = body.p_bill_to_customer_id === STRATA.id ? STRATA : STG;
    state.history = [{ id: state.history.length + 1, changed_at: "2026-09-16T16:05:00Z",
      from_customer: { name: previous.name }, to_customer: { name: state.current.name },
      changer: { display_name: me.display_name } }, ...state.history];
    return json(r, { project_id: JOB, bill_to_customer_id: state.current.id }, null);
  });
  return state;
}

async function jobCsv(page: Page, range: "custom" | "full") {
  await page.goto("/team-timecards");
  await page.getByRole("button", { name: "Export job timecards", exact: true }).click();
  const dialog = page.getByRole("dialog");
  if (range === "custom") {
    await dialog.getByRole("button", { name: "Custom range", exact: true }).click();
    await dialog.getByLabel("From date", { exact: true }).fill("2026-09-14");
    await dialog.getByLabel("Through date", { exact: true }).fill("2026-09-15");
  }
  await expect(dialog.locator(".detail-card > strong")).toHaveText("07:30");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV", exact: true }).click();
  const file = await download;
  return { name: file.suggestedFilename(), csv: await readFile((await file.path())!, "utf8"), dialog };
}

test("a supervisor sees the job's bill-to, changes it to Strata, and sees who changed it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixtures(page, "supervisor");
  await page.goto(`/projects/${JOB}`);
  const field = page.getByTestId("bill-to-field");
  const picker = field.getByRole("combobox", { name: "Bills to" });
  await expect(picker).toHaveValue(STG.id);
  await expect(field).toContainText("QuickBooks ID 4");
  await expect(field).toContainText("Not changed since the job was made.");
  await expect(field.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await picker.selectOption({ label: "Strata" });
  await field.getByRole("button", { name: "Save", exact: true }).click();
  await expect(field).toContainText("STG Windows and Doors → Strata, by Fixture Supervisor");
  await expect(field).toContainText("No QuickBooks ID yet");
  expect(state.calls).toEqual([{ p_project_id: JOB, p_bill_to_customer_id: STRATA.id }]);
  await expect(field.getByRole("link", { name: "Edit the bill-to list" })).toHaveAttribute("href", /\/cost-codes#bill-to$/);
  await field.screenshot({ path: "/tmp/forge-bill-to-field-390.png" });
});

test("a foreman sees no bill-to on the job, and the app never asks for it", async ({ page }) => {
  const state = await fixtures(page, "foreman");
  await page.goto(`/projects/${JOB}`);
  await expect(page.getByRole("heading", { name: /JOB-A/ }).first()).toBeVisible();
  await expect(page.getByText("GC", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("bill-to-field")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Bills to" })).toHaveCount(0);
  expect(state.reads).toBe(0);
});

test("a supervisor's Job timecards file ends with Bill To and its QuickBooks ID, in both date modes", async ({ page }) => {
  await fixtures(page, "supervisor");
  const custom = await jobCsv(page, "custom");
  expect(custom.name).toBe("Forge-JobTimecards(2026-09-14-2026-09-15).csv");
  const [header, row] = custom.csv.replace(/^﻿/, "").split("\r\n");
  expect(header).toBe("Employee Id,First Name,Last Name,Start,End,Break,Total,Customer,Project Number,Project,Cost Code,Cost Code Desc.,Equipment,Add-Ons,Description,Status,Time Zone,Bill To,Bill To QuickBooks ID");
  expect(row.endsWith(",approved,America/Denver,STG Windows and Doors,4")).toBe(true);
  await expect(custom.dialog.getByTestId("export-bill-to-note")).toBeVisible();

  await custom.dialog.getByRole("button", { name: "Full job history", exact: true }).click();
  await expect(custom.dialog.locator(".detail-card > strong")).toHaveText("07:30");
  const download = page.waitForEvent("download");
  await custom.dialog.getByRole("button", { name: "Download CSV", exact: true }).click();
  const full = await download;
  expect(full.suggestedFilename()).toBe("Forge-JobTimecards(all-time).csv");
  const fullCsv = await readFile((await full.path())!, "utf8");
  expect(fullCsv.split("\r\n")[0].endsWith(",Time Zone,Bill To,Bill To QuickBooks ID")).toBe(true);
});

test("a foreman's Job timecards file has neither column; Sees costs adds both", async ({ page, browser }) => {
  await fixtures(page, "foreman");
  const plain = await jobCsv(page, "custom");
  expect(plain.name).toBe("Forge-JobTimecards(2026-09-14-2026-09-15).csv");
  expect(plain.csv.replace(/^﻿/, "").split("\r\n")[0].endsWith(",Status,Time Zone")).toBe(true);
  expect(plain.csv).not.toContain("Bill To");
  await expect(plain.dialog.getByTestId("export-bill-to-note")).toHaveCount(0);

  const granted = await browser.newPage();
  await fixtures(granted, "foreman", true);
  const withGrant = await jobCsv(granted, "custom");
  expect(withGrant.csv.replace(/^﻿/, "").split("\r\n")[0].endsWith(",Time Zone,Bill To,Bill To QuickBooks ID")).toBe(true);
  await granted.close();
});

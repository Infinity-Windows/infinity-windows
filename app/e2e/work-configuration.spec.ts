// Disposable intercepted fixtures only. Nothing reaches the real backend.
import { expect, test, type Page } from "@playwright/test";
import { jobFixtures, TEST_USER, useSupabaseFixtures as installSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";
const JOB = jobFixtures().find(j => j.jobCode === "OAKRIDGE")!;
const DEF = "00000000-0000-4000-8000-000000000100", VERSION = "00000000-0000-4000-8000-000000000101";
const MENU = "00000000-0000-4000-8000-000000000102", MENU_VERSION = "00000000-0000-4000-8000-000000000103";
const at = "2026-10-03T12:00:00.123456Z", marker = "Private configuration fixture";
const catalog = {
  protocolVersion: 1, role: "company", asOf: at, projectId: null, currentSelection: null,
  activities: [{ code: "shimming", definitionId: DEF, retiredAt: null, versions: [{ versionId: VERSION, version: 1, scope: "specific", labelEn: marker, labelEs: "Calzar", machineSelection: false, typedFields: [], publishedAt: at, effectiveFrom: at, eligibleNow: true }] }],
  menus: [{ code: "standard", menuId: MENU, retiredAt: null, versions: [{ versionId: MENU_VERSION, version: 1, labelEn: "Standard fixture", labelEs: "Estándar", items: [{ definitionId: DEF, versionId: VERSION, position: 0, enabled: true }], publishedAt: at, effectiveFrom: at, eligibleNow: true }] }],
  drafts: [{ kind: "activity", code: "shimming", revision: 2, draftId: "00000000-0000-4000-8000-000000000104", proposedBy: TEST_USER.id, createdAt: at, body: { scope: "specific", labelEn: marker, labelEs: "Calzar", machineSelection: false, typedFields: [] } }],
};
async function fixtures(page: Page, role: "owner" | "supervisor" | "foreman" | "installer" = "owner") {
  await installSupabaseFixtures(page, { role, uiDesign: "new" }); await hideWrongProjectBanner(page);
  const commands: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/work_configuration_snapshot", route => json(route, catalog, null));
  await page.route("**/rest/v1/rpc/work_propose_activity_draft", route => { const args = route.request().postDataJSON(); commands.push(args); return json(route, { protocolVersion: 1, kind: "activity", code: args.p_code, revision: args.p_expected_revision + 1, draftId: "00000000-0000-4000-8000-000000000105" }, null); });
  await page.route("**/rest/v1/rpc/work_job_menu_choices", route => json(route, { protocolVersion: 1, projectId: JOB.projectId, asOf: at, currentRevision: 2, currentSelection: { revision: 2, menuVersionId: MENU_VERSION }, choices: [{ menuVersionId: MENU_VERSION, version: 1, labelEn: "Standard fixture", labelEs: "Estándar", publishedAt: at, effectiveFrom: at }] }, null));
  await page.route("**/rest/v1/rpc/work_job_capability_grants", route => json(route, { protocolVersion: 1, projectId: JOB.projectId, grants: [] }, null));
  return commands;
}
async function fits(page: Page, selector: string) {
  expect(await page.evaluate(selector => ({
    overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    outside: [...document.querySelectorAll<HTMLElement>(`${selector} *`)].filter(e => e.getClientRects().length && (e.getBoundingClientRect().right > innerWidth + .1 || e.getBoundingClientRect().left < -.1)).map(e => `${e.tagName}.${e.className}`),
  }), selector)).toEqual({ overflow: 0, outside: [] });
}
test("company activity/menu editors stay usable on phone portrait and landscape", async ({ page }) => {
  const commands = await fixtures(page); await page.goto("/settings");
  const card = page.locator(".wc-settings"); await expect(card.getByRole("heading", { name: "Work configuration", exact: true })).toBeVisible();
  await card.getByRole("button", { name: `${marker} shimming`, exact: true }).click();
  await card.getByRole("button", { name: "Add field", exact: true }).click();
  const field = card.locator(".wc-subcard"); await field.getByLabel("Field ID", { exact: true }).fill("shim_count"); await field.getByRole("combobox", { name: "Type", exact: true }).selectOption("number");
  await field.getByLabel("English label", { exact: true }).fill("Shim count"); await field.getByLabel("Spanish label", { exact: true }).fill("Cantidad"); await field.getByRole("combobox", { name: "Unit", exact: true }).selectOption("count"); await field.getByLabel("Minimum", { exact: true }).fill("0");
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) { await page.setViewportSize(viewport); await fits(page, ".wc-settings"); }
  await card.getByRole("button", { name: "Save proposal", exact: true }).click(); expect(commands).toHaveLength(1); expect(commands[0].p_expected_revision).toBe(2); expect(commands[0].p_typed_fields).toMatchObject([{ id: "shim_count", type: "number", unit: "count", min: 0 }]);
  await card.getByRole("button", { name: "Standard fixture standard", exact: true }).click();
  await expect(card.getByRole("combobox", { name: "shimming published version", exact: true })).toHaveValue(VERSION);
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) { await page.setViewportSize(viewport); await fits(page, ".wc-settings"); }
});
test("typing a new activity and menu code preserves focus through every character", async ({ page }) => {
  await fixtures(page); await page.goto("/settings"); const card=page.locator(".wc-settings");
  for(const [button, code] of [["New activity","fixture_install"],["New menu","fixture_menu"]]) {
    await card.getByRole("button",{name:button,exact:true}).click();
    const input=card.getByRole("textbox",{name:"Stable code",exact:true});
    await input.pressSequentially(code); await expect(input).toHaveValue(code); await expect(input).toBeFocused();
  }
});
test("supervisor proposes and never sees owner publication controls", async ({ page }) => {
  await fixtures(page, "supervisor"); await page.goto("/settings"); const card = page.locator(".wc-settings");
  await card.getByRole("button", { name: `${marker} shimming`, exact: true }).click();
  await expect(card.getByRole("button", { name: "Save proposal", exact: true })).toBeVisible(); await expect(card.getByRole("button", { name: "Publish new version", exact: true })).toHaveCount(0);
});
test("company private data disappears offline and never enters persisted storage", async ({ page, context }) => {
  await fixtures(page); await page.goto("/settings"); await expect(page.locator(".wc-settings")).toContainText(marker);
  expect(await page.evaluate(marker => Object.values(localStorage).join(" ").includes(marker), marker)).toBe(false);
  await context.setOffline(true); await expect(page.locator(".wc-settings")).not.toContainText(marker); await context.setOffline(false);
});
test("exact-job picker uses its checked revision and stays within phone widths", async ({ page }) => {
  await fixtures(page); const requests: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/work_select_job_menu", route => { const args = route.request().postDataJSON(); requests.push(args); return json(route, { protocolVersion: 1, projectId: JOB.projectId, revision: 3, menuVersionId: MENU_VERSION, selectionId: "00000000-0000-4000-8000-000000000106", frozenDefinitionVersionIds: [VERSION] }, null); });
  await page.goto(`/projects/${JOB.projectId}`); const panel = page.locator(".work-job-configuration"); await expect(panel.getByRole("heading", { name: "Work menu and job permissions" })).toBeVisible();
  await panel.getByRole("combobox", { name: "Published menu", exact: true }).selectOption(MENU_VERSION);
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) { await page.setViewportSize(viewport); await fits(page, ".work-job-configuration"); }
  await panel.getByRole("button", { name: "Use this menu", exact: true }).click(); await expect(panel).toContainText("Saved."); expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ p_project_id: JOB.projectId, p_menu_version_id: MENU_VERSION, p_expected_current_revision: 2 });
});
test("installer settings do not read company configuration", async ({ page }) => {
  await fixtures(page, "installer"); let reads = 0; await page.route("**/rest/v1/rpc/work_configuration_snapshot", route => { reads++; return json(route, catalog, null); });
  await page.goto("/settings"); await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible(); await expect(page.locator(".wc-settings")).toHaveCount(0); expect(reads).toBe(0);
});

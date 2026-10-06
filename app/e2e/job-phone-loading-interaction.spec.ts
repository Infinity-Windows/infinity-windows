// Job details Edit while the two lazy overview cards are still loading
// (phone layout follow-up, 2026-10-06).
//
// job-phone-layout.spec.ts measures the SETTLED overview and then clicks Edit.
// This independent file asks the other question it leaves open: if a person
// taps Edit before the lazy Work configuration and Crew goal cards have
// arrived, does the editor open, keep its values and still fit once those
// cards land above it? (ProjectDetail.tsx renders both through
// <Suspense fallback={null}> directly above JobDetailsPanel.)
//
// The two chunks are held at the dev server's module request — the exact
// local /src/... modules ProjectDetail lazy-imports — by a deferred gate that
// is installed before navigation and only opened by this test. No sleep,
// delay, retry, force click, app patch or fixture state change.
//
// What this does NOT prove, stated so nobody counts it as more: the click
// completes while the modules are still held, so the cards are inserted AFTER
// the native dispatch, never inside it. It does not reproduce the retained
// Linux WebKit 375px failure (69e8) or establish its cause. Pointer/click
// observations below are passive test-only diagnostics of THIS run, not the
// original failure's target. Synthetic owner, fixture Supabase, dev-server
// modules — not the installed PWA, a production bundle or a physical phone.
// Write guards cover REST tables; RPC POSTs are excluded, so an empty table
// ledger is not global mutation coverage.

import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const job = jobFixtures().find((row) => row.jobCode === "BLACK22")!;
const HELD_MODULES = [
  "/src/components/projects/CrewGoalCard.tsx",
  "/src/components/workConfiguration/WorkJobConfiguration.tsx",
] as const;

// The same project row job-phone-layout.spec.ts serves at widths under 390
// (tracking job, long contact/notes), duplicated here rather than shared.
const project = {
  id: job.projectId,
  job_code: "BLACK22",
  name: "Black Desert",
  status: "active",
  allowed_modes: ["tracking"],
  is_test: false,
  start_date: "2026-08-05",
  end_date: "2026-08-26",
  customer_name: "Site office",
  contact_email: `${"long-contact".repeat(12)}@example.com`,
  notes: "LongJobReference".repeat(24),
};

interface Observed { type: string; isTrusted: boolean; target: string; onEdit: boolean; x: number; y: number; button: { text: string; x: number; y: number; w: number; h: number } | null }

/** Every input/textarea value in the editor, by its field label, in DOM order. */
async function editorValues(page: Page) {
  return page.locator("section.job-details-card").locator("input, textarea").evaluateAll((els) =>
    els.map((el) => [el.closest("label")?.querySelector(".field-label")?.textContent ?? "", (el as HTMLInputElement).value]));
}

async function expectEditorFits(page: Page, width: number) {
  const details = page.locator("section.job-details-card");
  expect(await details.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await details.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(width).toBe(await page.evaluate(() => innerWidth));
}

for (const { width, design } of [{ width: 375, design: "new" }, { width: 320, design: "classic" }] as const) {
  test(`Edit opened while the lazy overview cards are held keeps its editor at ${width}px (${design})`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 844 });
    await useSupabaseFixtures(page, { role: "owner", uiDesign: design });
    await page.route("**/rest/v1/company_settings**", (route) => json(route, { id: 1, new_design_r1_enabled: true }, 1));
    await hideWrongProjectBanner(page);
    await page.addInitScript(() => localStorage.setItem("infinity.theme", "dark"));

    // Reads only. A write to projects is refused and logged, never fulfilled.
    const projectWrites: string[] = [];
    await page.route("**/rest/v1/projects**", (route) => {
      if (route.request().method() === "GET" || route.request().method() === "HEAD") return json(route, [project], 1);
      projectWrites.push(`${route.request().method()} ${route.request().url()}`);
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "loading-interaction spec refuses project writes" }) });
    });
    const tableWrites: string[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith("/rest/v1/") && !path.startsWith("/rest/v1/rpc/") && req.method() !== "GET" && req.method() !== "HEAD") {
        tableWrites.push(`${req.method()} ${path}`);
      }
    });
    // The same three read RPC answers as job-phone-layout.spec.ts.
    await page.route("**/rest/v1/rpc/work_job_menu_choices", (route) => json(route, {
      protocolVersion: 1, projectId: job.projectId, asOf: "2026-10-05T12:00:00Z",
      currentRevision: 0, currentSelection: null, choices: [],
    }, null));
    await page.route("**/rest/v1/rpc/work_job_capability_grants", (route) => json(route, {
      protocolVersion: 1, projectId: job.projectId, grants: [],
    }, null));
    await page.route("**/rest/v1/rpc/crew_goal_summary", (route) => json(route, {
      goal_hours: null, goal_revision: null, goal_updated_at: null,
      recorded_hours: 0, running_provisional_hours: 0, open_shifts: 0,
      unresolved_shifts: 0, allowance_hours: null, as_of: "2026-10-05T12:00:00Z",
    }, null));

    // The deferred gate: installed before navigation, opened only by this test
    // (or by `finally`, so a failure never leaves a held route behind).
    const origin = new URL(baseURL!).origin;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held: string[] = [];
    const isHeld = (url: URL) => url.origin === origin && HELD_MODULES.some((m) => url.pathname.endsWith(m));
    await page.route(isHeld, async (route: Route) => {
      held.push(route.request().url());
      await gate;
      try {
        await route.fallback();
      } catch (error) {
        if (!page.isClosed()) throw error;
      }
    });

    try {
      await page.goto(`/projects/${job.projectId}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute("data-design", design);
      if (design === "new") await expect(page.getByRole("navigation", { name: "Main" }).getByText("Work", { exact: true })).toBeVisible();

      // Both chunks were asked for and are being held; neither card exists yet.
      await expect.poll(() => held.map((u) => HELD_MODULES.find((m) => new URL(u).pathname.endsWith(m))).sort()).toEqual([...HELD_MODULES].sort());
      await expect(page.locator(".work-job-configuration")).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Crew goal", exact: true })).toHaveCount(0);

      const details = page.locator("section.job-details-card");
      await expect(details.getByRole("heading", { name: "Job details", exact: true })).toBeVisible();
      const edit = details.getByRole("button", { name: "Edit", exact: true });
      await expect(edit).toBeEnabled();
      const editBox = await edit.boundingBox();

      // Passive capture-phase observers: they read events, never cancel,
      // dispatch or change anything.
      await page.evaluate(() => {
        const log: unknown[] = [];
        (window as unknown as { __jobEditEvents: unknown[] }).__jobEditEvents = log;
        const describe = (el: Element | null) => el ? `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).split(" ").join(".")}` : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"` : "null";
        for (const type of ["pointerdown", "pointerup", "click"]) {
          document.addEventListener(type, (e) => {
            const target = e.target instanceof Element ? e.target : null;
            const button = document.querySelector(".job-details-card .job-details-header button");
            const r = button?.getBoundingClientRect();
            log.push({
              type, isTrusted: e.isTrusted, target: describe(target),
              onEdit: Boolean(button && target && button.contains(target) && button.textContent?.trim() === "Edit"),
              x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY,
              button: button && r ? { text: (button.textContent ?? "").trim(), x: r.x, y: r.y, w: r.width, h: r.height } : null,
            });
          }, { capture: true, passive: true });
        }
      });

      // One native click while both modules are still held.
      await edit.click();
      expect(held).toHaveLength(2);
      await expect(page.locator(".work-job-configuration")).toHaveCount(0);
      await expect(details.getByRole("heading", { name: "Edit job details", exact: true })).toBeVisible();
      await expect(details.getByLabel("Project name", { exact: true })).toHaveValue(project.name);
      await expect(details.getByLabel("Customer / contact", { exact: true })).toHaveValue(project.customer_name);
      await expect(details.getByLabel("Contact email", { exact: true })).toHaveValue(project.contact_email);
      const before = await editorValues(page);
      expect(before.map(([, v]) => v)).toEqual(expect.arrayContaining([project.start_date, project.end_date, project.notes]));
      await expectEditorFits(page, width);
      const events = await page.evaluate(() => (window as unknown as { __jobEditEvents: Observed[] }).__jobEditEvents);
      expect(events.map((e) => e.type)).toEqual(["pointerdown", "pointerup", "click"]);
      expect(events.every((e) => e.isTrusted && e.onEdit)).toBe(true);

      // Let the cards arrive above the open editor, then wait for their terminal states.
      release();
      await expect(page.locator(".work-job-configuration").getByText("There are no eligible published menus.", { exact: true })).toBeVisible();
      await expect(page.locator(".work-job-configuration").getByText("No active foreman permissions.", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Crew goal", exact: true }).getByRole("heading", { name: "Crew goal", exact: true })).toBeVisible();

      await expect(details.getByRole("heading", { name: "Edit job details", exact: true })).toBeVisible();
      expect(await editorValues(page)).toEqual(before);
      await expectEditorFits(page, width);

      await details.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(details.getByRole("heading", { name: "Job details", exact: true })).toBeVisible();
      await expect(details.getByRole("heading", { name: "Edit job details", exact: true })).toHaveCount(0);
      expect(projectWrites).toEqual([]);
      expect(tableWrites).toEqual([]);

      test.info().annotations.push(
        { type: "held module requests", description: JSON.stringify(held) },
        { type: "Edit button box before click (Playwright)", description: JSON.stringify(editBox) },
        { type: "passive pointer/click receipt (this run only)", description: JSON.stringify(events) },
        { type: "editor values before and after the cards arrived", description: JSON.stringify({ before }) },
        { type: "limit", description: "Modules held until AFTER a completed click: cards insert after native dispatch, not inside it. Does not reproduce the retained Linux WebKit 375px failure or prove its cause. Fixture owner, dev-server modules; not PWA, production bundle or physical phone." },
      );
    } finally {
      release();
    }
  });
}

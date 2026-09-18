import { test, expect, type Page } from "@playwright/test";
import {
  useSupabaseFixtures as installFixtures,
  TEST_USER,
  jobFixtures,
  openingsFor,
} from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";
import {
  emptyServiceUnit,
  type ServiceVisit,
  type ServiceUnit,
  type ServiceSession,
  type ServiceMedia,
} from "../src/lib/servicing/model";
import fs from "node:fs";
const counted = (rows: unknown[]) => ({
  status: 200,
  contentType: "application/json",
  headers: {
    "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`,
    "access-control-expose-headers": "content-range",
  },
  body: JSON.stringify(rows),
});
async function setup(
  page: Page,
  role: "installer" | "foreman" | "supervisor" | "owner" = "installer",
  complete = false,
  language: "en" | "es" = "en",
) {
  await installFixtures(page, { role, language });
  await hideWrongProjectBanner(page);
  const project = jobFixtures()[0].projectId;
  const shift = {
    id: "11111111-1111-4111-8111-111111111111",
    profile_id: TEST_USER.id,
    project_id: project,
    clock_in_at: new Date(Date.now() - 3600000).toISOString(),
    clock_out_at: null,
    break_started_at: null,
    status: "open",
    break_seconds: 0,
  };
  const state = {
    visits: [] as ServiceVisit[],
    units: [] as ServiceUnit[],
    sessions: [] as ServiceSession[],
    media: [] as ServiceMedia[],
    offline: false,
  };
  await page.route("**/rest/v1/time_shifts**", (r) =>
    json(r, r.request().headers().accept?.includes("object") ? shift : [shift]),
  );
  for (const [table, key] of [
    ["service_visits", "visits"],
    ["service_visit_units", "units"],
    ["service_time_sessions", "sessions"],
    ["service_media", "media"],
  ] as const) {
    await page.route(`**/rest/v1/${table}**`, (r) => {
      const url = new URL(r.request().url());
      let rows = [...state[key]];
      const visit = url.searchParams.get("visit_id")?.slice(3);
      if (visit)
        rows = rows.filter((x) => "visit_id" in x && x.visit_id === visit);
      const id = url.searchParams.get("id")?.slice(3);
      if (id) rows = rows.filter((x) => x.id === id);
      if (url.searchParams.has("ended_at"))
        rows = rows.filter((x) => "ended_at" in x && x.ended_at === null);
      return r.request().headers().accept?.includes("object")
        ? json(r, rows[0] ?? null)
        : r.fulfill(counted(rows));
    });
  }
  await page.route("**/rest/v1/service_job_supervisors**", (r) =>
    json(r, null),
  );
  await page.route("**/rest/v1/custom_work_units**", (r) =>
    r.fulfill(counted([])),
  );
  await page.route("**/rest/v1/rpc/service_shift_bounds", (r) =>
    json(
      r,
      Object.fromEntries(
        state.sessions.map((s) => [s.shift_id, s.time_shifts]),
      ),
    ),
  );
  await page.route("**/rest/v1/rpc/service_command", async (r) => {
    if (state.offline) return r.abort("internetdisconnected");
    const { p_action: action, p_data: d } = r.request().postDataJSON();
    const now = new Date().toISOString();
    let v = state.visits.find((v) => v.id === d.visit_id);
    if (action === "visit" && !v) {
      v = {
        ...d,
        created_by: TEST_USER.id,
        status: "active",
        revision: 1,
        created_at: now,
        updated_at: now,
        reviewed_at: null,
        reviewed_by: null,
        completed_at: null,
        allocation: null,
        lodging_message_id: null,
      };
      state.visits.push(v!);
    } else if (action === "visit" && v) {
      v.details = d.details;
      v.revision++;
      if (d.details.lodging) v.lodging_message_id = "message";
    }
    if (action === "unit") {
      const old = state.units.find((u) => u.id === d.id);
      state.units = state.units.filter((u) => u.id !== d.id);
      state.units.push({
        ...emptyServiceUnit(d.visit_id, project),
        ...d,
        created_by: TEST_USER.id,
        revision: (old?.revision ?? 0) + 1,
      });
    }
    if (action === "start" || action === "stop") {
      state.sessions = state.sessions.map((s) =>
        s.id === d.expected_session_id
          ? { ...s, ended_at: d.at, end_reason: "stop" }
          : s,
      );
      if (action === "start")
        state.sessions.push({
          ...d,
          profile_id: TEST_USER.id,
          project_id: project,
          started_at: d.at,
          ended_at: null,
          end_reason: null,
          review_required: false,
          profiles: { display_name: "Test Worker" },
          time_shifts: shift,
        });
    }
    if (action === "media")
      state.media.push({
        ...d,
        project_id: project,
        created_by: TEST_USER.id,
        revision: 1,
        transcript: "",
        caption: "",
        created_at: now,
        content_type: d.content_type,
        storage_path: d.storage_path,
      });
    if (action === "finish" && v) {
      v.status = "completed";
      v.completed_at = now;
      v.revision++;
    }
    if (action === "review" && v) {
      v.reviewed_at = now;
      v.allocation = d.allocation;
    }
    if (v && ["unit", "start", "stop", "media", "transcript"].includes(action))
      v.revision++;
    return json(r, d.id ?? d.visit_id ?? d.expected_session_id);
  });
  if (complete) {
    const id = "22222222-2222-4222-8222-222222222222";
    state.visits.push({
      id,
      project_id: project,
      created_by: TEST_USER.id,
      previous_visit_id: null,
      status: "completed",
      details: { crew_names: "Test Worker", scheduled_date: "2026-09-17" },
      revision: 1,
      created_at: "2026-09-17T12:00:00Z",
      updated_at: "2026-09-17T12:00:00Z",
      completed_at: "2026-09-17T14:00:00Z",
      reviewed_at: null,
      reviewed_by: null,
      allocation: null,
      lodging_message_id: null,
    });
    const u = {
      ...emptyServiceUnit(id, project),
      label: "7",
      type_label: "Sliding door",
      issue: "Roller binds",
      cause: "manufacturer" as const,
      fail_point: "Hardware",
      repair: "Replaced factory roller",
      verification: "Opens and locks",
      outcome: "resolved" as const,
      memo_text:
        "Replaced the roller and checked operation.\n" +
        "Long explanation stays fully visible. ".repeat(20),
      evidence_exception:
        "Camera unavailable; supervisor can review this typed report",
      revision: 1,
    };
    state.units.push(u);
    state.sessions.push({
      id: "labor",
      visit_id: id,
      project_id: project,
      unit_id: u.id,
      shift_id: shift.id,
      profile_id: TEST_USER.id,
      kind: "unit",
      stage: "Repair",
      description: "Changed roller",
      started_at: "2026-09-17T12:00:00Z",
      ended_at: "2026-09-17T13:00:00Z",
      end_reason: "stop",
      review_required: false,
      profiles: { display_name: "Test Worker" },
      time_shifts: {
        ...shift,
        clock_in_at: "2026-09-17T12:00:00Z",
        clock_out_at: "2026-09-17T14:00:00Z",
        status: "submitted",
      },
    });
  }
  return { state, project };
}
for (const role of ["installer", "foreman", "supervisor", "owner"] as const)
  test(`${role} creates a service visit, unit and idle time`, async ({
    page,
  }) => {
    const { state, project } = await setup(page, role);
    await page.goto("/service");
    await expect(
      page.getByRole("heading", { name: "Servicing", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Job", exact: true })
      .selectOption(project);
    await page
      .getByRole("button", { name: "Start a service visit", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Add a unit", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add a unit", exact: true }).click();
    const editor = page.getByRole("region", { name: "Edit unit report" });
    await editor.getByLabel("Unit number / name").fill("7");
    await editor.getByLabel("Window / door type").fill("Sliding door");
    await editor
      .getByLabel("Reported issue / what did you find?")
      .fill("Door binds on a factory roller.");
    await editor
      .getByRole("button", { name: "Save and start this unit" })
      .click();
    await expect.poll(() => state.sessions.length).toBe(1);
    await expect(
      page.getByRole("button", { name: "Stop service timer" }),
    ).toBeEnabled();
    await page
      .getByLabel("What are you doing?", { exact: true })
      .fill("Getting replacement hardware");
    await page.getByRole("button", { name: "Idle time", exact: true }).click();
    await expect.poll(() => state.sessions.length).toBe(2);
    expect(state.sessions[0].ended_at).toBeTruthy();
    expect(state.sessions[1].kind).toBe("idle");
    await page.getByRole("button", { name: "Stop service timer" }).click();
    await page
      .getByRole("button", { name: "Finish visit", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "New return visit", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Download service PDF", exact: true }),
    ).toBeDisabled();
  });
for (const width of [375, 390, 1280])
  for (const lang of ["en", "es"] as const)
    test(`completed report ${width}px ${lang}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (l) => localStorage.setItem("infinity.language", l),
        lang,
      );
      const { state } = await setup(page, "supervisor", true, lang);
      await page.goto("/service?visit=" + state.visits[0].id);
      await expect(
        page.getByRole("heading", {
          name: lang === "en" ? "Servicing" : "Servicio técnico",
          exact: true,
        }),
      ).toBeVisible();
      const root = page.locator(".servicing");
      expect(
        await root.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await expect(
        page.getByRole("button", {
          name:
            lang === "en"
              ? "Download service PDF"
              : "Descargar PDF de servicio",
          exact: true,
        }),
      ).toBeEnabled();
      await page.screenshot({
        path: `/tmp/forge-servicing-${width}-${lang}.png`,
        fullPage: true,
      });
      if (lang === "en" && width === 1280) {
        const pdf = page.waitForEvent("download");
        await page
          .getByRole("button", { name: "Download service PDF", exact: true })
          .click();
        const file = await (await pdf).path();
        fs.copyFileSync(file!, "/tmp/forge-servicing-report.pdf");
        expect(fs.readFileSync(file!).subarray(0, 4).toString()).toBe("%PDF");
        const csv = page.waitForEvent("download");
        await page
          .getByRole("button", { name: "Export service hours", exact: true })
          .click();
        expect(fs.readFileSync((await (await csv).path())!, "utf8")).toContain(
          "1.000000",
        );
        await page
          .getByText("Review billing & shared costs", { exact: true })
          .click();
        await page.getByLabel("Strata share (%)").fill("100");
        await page
          .getByLabel("Explain the shared-cost split")
          .fill("Only factory repair on this trip.");
        await page
          .getByRole("button", { name: "Approve billing review" })
          .click();
        await expect.poll(() => state.visits[0].reviewed_at).toBeTruthy();
      }
    });
test("map selection can seed a service unit without changing the installed opening", async ({
  page,
}) => {
  const { project } = await setup(page);
  const opening = openingsFor(project)[0];
  await page.goto(`/service?job=${project}&opening=${opening.id}`);
  await page.getByRole("button", { name: "Start a service visit" }).click();
  await expect(page.getByLabel("Unit number / name")).toHaveValue(
    opening.opening_code,
  );
});

test("offline timer changes remain on the device and replay once", async ({
  page,
}) => {
  const { state, project } = await setup(page);
  await page.goto("/service");
  await page
    .getByRole("combobox", { name: "Job", exact: true })
    .selectOption(project);
  await page
    .getByRole("button", { name: "Start a service visit", exact: true })
    .click();
  await page.getByRole("button", { name: "Add a unit", exact: true }).click();
  const editor = page.getByRole("region", { name: "Edit unit report" });
  await editor.getByLabel("Unit number / name").fill("Offline 8");
  await editor.getByLabel("Window / door type").fill("Fixed window");
  await editor
    .getByLabel("Reported issue / what did you find?")
    .fill("Seal leak");
  await editor
    .getByRole("button", { name: "Save and start this unit" })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop service timer" }),
  ).toBeEnabled();
  state.offline = true;
  await page
    .getByLabel("What are you doing?", { exact: true })
    .fill("Picking up supplies");
  await page.getByRole("button", { name: "Idle time", exact: true }).click();
  await expect(page.locator(".sv-notice")).toContainText(
    "Saved on this device",
  );
  await expect(
    page.getByRole("button", { name: "Stop service timer" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop service timer" }).click();
  state.offline = false;
  await page.getByRole("button", { name: "Refresh / sync" }).click();
  await expect.poll(() => state.sessions.length).toBe(2);
  await expect.poll(() => state.sessions.every((s) => !!s.ended_at)).toBe(true);
  await page.getByRole("button", { name: "Refresh / sync" }).click();
  expect(state.sessions).toHaveLength(2);
});

test("original photos and audio are saved and included in the export packet", async ({
  page,
}) => {
  const { state } = await setup(page, "supervisor", true);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII=",
    "base64",
  );
  const originals = new Map<string, Buffer>();
  await page.route("**/storage/v1/object/service-media/**", async (r) => {
    const key = new URL(r.request().url()).pathname;
    if (r.request().method() === "POST") {
      originals.set(key, r.request().postDataBuffer()!);
      return json(r, { Key: key });
    }
    return r.fulfill({
      status: 200,
      body: key.endsWith(".png") ? png : Buffer.from("original memo fixture"),
      contentType: key.endsWith(".png") ? "image/png" : "audio/webm",
    });
  });
  await page.goto("/service?visit=" + state.visits[0].id);
  await page
    .locator('input[type=file][accept="image/*"]:not([capture])')
    .setInputFiles({ name: "before.png", mimeType: "image/png", buffer: png });
  await expect.poll(() => state.media.length).toBe(1);
  await page
    .getByRole("combobox", { name: "Evidence type" })
    .selectOption("voice");
  await page
    .locator('input[type=file][accept="audio/*"]')
    .setInputFiles({
      name: "memo.webm",
      mimeType: "audio/webm",
      buffer: Buffer.from("original memo fixture"),
    });
  await expect.poll(() => state.media.length).toBe(2);
  await expect(
    page.getByRole("button", {
      name: "Download report & evidence ZIP",
      exact: true,
    }),
  ).toBeEnabled();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Download report & evidence ZIP",
      exact: true,
    })
    .click();
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(
    fs.readFileSync((await (await download).path())!),
  );
  expect(Object.keys(zip.files).some((x) => x.endsWith("before.png"))).toBe(
    true,
  );
  const memo = Object.keys(zip.files).find((x) => x.endsWith("memo.webm"))!;
  expect(await zip.file(memo)!.async("string")).toBe("original memo fixture");
  expect(originals.size).toBe(2);
});

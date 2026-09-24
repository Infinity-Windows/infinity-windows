// The morning a Release 1 spec walks through, replayed from hand-built rows.
//
// Shared by the new-design, Work, Start day, Schedule and Prep time specs so
// they agree on the one geometry that matters: today's published job is
// OAKRIDGE, yesterday's punch was BLACK22, a talk exists for today, and
// whether it is signed and whether the paid-time rule is on are the two
// knobs each spec turns. Registered AFTER useSupabaseFixtures so these win.

import type { Page } from "@playwright/test";
import { TEST_USER } from "./supabaseFixtures";
import { dayISO, json } from "./specHelpers";

export const BLACK22 = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
export const OAKRIDGE = "3cc5b810-45e0-4445-a115-efa98f8efad3";
export const GENERAL = "11111111-aaaa-4aaa-8aaa-111111111111";
export const INSTALL = "22222222-bbbb-4bbb-8bbb-222222222222";

const COST_CODES = [
  { id: GENERAL, code: "000", label: "General", description: null, active: true, sort_order: 5, is_general: true },
  { id: INSTALL, code: "100", label: "Install — windows", description: null, active: true, sort_order: 10, is_general: false },
];

export const TALK = {
  id: "33333333-cccc-4ccc-8ccc-333333333333",
  title: "Ladders",
  body: "Three points of contact. Inspect before you climb.",
  talk_date: dayISO(0),
  key_points: ["Three points of contact", "Inspect the rungs and feet"],
  watch_for: ["Wet rungs"],
  stop_work_line: "A cracked rail is a stop-work.",
  pledge: null,
  created_at: `${dayISO(0)}T06:00:00Z`,
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

export interface MorningOptions {
  /** Today's talk already signed. */
  signed?: boolean;
  /** The owner's paid-time date, "YYYY-MM-DD" or null (off). */
  paidTimeFrom?: string | null;
  /** The owner's master switch for Release 1. */
  newDesignOn?: boolean;
  /** Already on the clock when the page opens. */
  openShift?: boolean;
  /** Today's published assignment (default: OAKRIDGE at 7:00). */
  scheduleRows?: Record<string, unknown>[] | null;
  /** A plan opening assigned to this person on OAKRIDGE. */
  myOpening?: boolean;
}

export interface MorningWorld {
  clockIns: Record<string, unknown>[];
  workCommands: Record<string, unknown>[];
  designWrites: string[];
  signatures: number;
}

export async function morningFixtures(page: Page, opts: MorningOptions = {}): Promise<MorningWorld> {
  const world: MorningWorld = { clockIns: [], workCommands: [], designWrites: [], signatures: 0 };
  let signed: Record<string, unknown> | null = opts.signed
    ? { id: "44444444-dddd-4ddd-8ddd-444444444444", profile_id: TEST_USER.id, talk_id: TALK.id, signed_at: new Date().toISOString(), signed_via: "self" }
    : null;
  let openShift: Record<string, unknown> | null = opts.openShift
    ? {
        id: "55555555-eeee-4eee-8eee-555555555555",
        profile_id: TEST_USER.id,
        project_id: OAKRIDGE,
        cost_code_id: INSTALL,
        clock_in_at: hoursAgo(2),
        clock_out_at: null,
        break_seconds: 0,
        break_started_at: null,
        break_type: null,
        injured: null,
        time_confirmed: null,
        status: "open",
        created_at: hoursAgo(2),
        note: null,
        projects: { job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" },
        cost_codes: { code: "100", label: "Install — windows" },
      }
    : null;

  const today = dayISO(0);
  const scheduleRows =
    opts.scheduleRows === null
      ? []
      : opts.scheduleRows ?? [
          {
            id: "a-today",
            project_id: OAKRIDGE,
            kind: "install",
            delivery_id: null,
            start_date: today,
            end_date: today,
            start_time: "07:00",
            end_time: "15:30",
            status: "published",
            color: null,
            note: null,
            created_by: null,
            published_at: `${dayISO(-3)}T12:00:00Z`,
            created_at: `${dayISO(-3)}T12:00:00Z`,
            updated_at: hoursAgo(1),
            projects: { id: OAKRIDGE, job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C", address: "1200 Oak Ridge Dr, St. George, UT" },
            schedule_assignment_members: [
              { profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "E2E Fixture" } },
              { profile_id: "00000000-0000-4000-8000-0000000000f1", role: "foreman", profiles: { display_name: "Sam" } },
            ],
          },
          {
            id: "a-wed",
            project_id: BLACK22,
            kind: "install",
            delivery_id: null,
            start_date: dayISO(2),
            end_date: dayISO(2),
            start_time: "06:30",
            end_time: null,
            status: "published",
            color: null,
            note: null,
            created_by: null,
            published_at: `${dayISO(-3)}T12:00:00Z`,
            created_at: `${dayISO(-3)}T12:00:00Z`,
            updated_at: `${dayISO(-3)}T12:00:00Z`,
            projects: { id: BLACK22, job_code: "BLACK22", name: "Black Desert", address: null },
            schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "E2E Fixture" } }],
          },
        ];

  await page.route("**/rest/v1/company_settings**", (r) =>
    json(r, {
      id: 1,
      evening_nudge_local_time: "17:30:00",
      evening_nudge_enabled: true,
      new_design_r1_enabled: opts.newDesignOn ?? true,
      paid_time_from_start_day_on: opts.paidTimeFrom ?? null,
    }, 1),
  );
  await page.route("**/rest/v1/safety_talks**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    return accept.includes("pgrst.object") ? json(r, TALK, 1) : json(r, [TALK], 1);
  });
  await page.route("**/rest/v1/toolbox_completions**", (r) => {
    if (r.request().method() === "POST") {
      const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
      world.signatures++;
      signed = { id: "44444444-dddd-4ddd-8ddd-444444444444", ...body, signed_at: new Date().toISOString(), signed_via: "self" };
      return json(r, signed, 1);
    }
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, signed, signed ? 1 : 0);
    return json(r, signed ? [signed] : [], signed ? 1 : 0);
  });
  await page.route("**/storage/v1/object/toolbox-records/**", (r) => json(r, { Key: "toolbox-records/e2e" }, null));
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const url = new URL(r.request().url());
    if ((url.searchParams.get("status") ?? "").startsWith("in.")) {
      return json(r, openShift ? [openShift] : [], openShift ? 1 : 0);
    }
    const recents = [{ project_id: BLACK22, cost_code_id: GENERAL, clock_in_at: hoursAgo(26), projects: { job_code: "BLACK22", name: "Black Desert" } }];
    return json(r, recents, recents.length);
  });
  await page.route("**/rest/v1/cost_codes**", (r) => json(r, COST_CODES, COST_CODES.length));
  await page.route("**/rest/v1/project_cost_codes**", (r) => json(r, [], 0));
  await page.route("**/rest/v1/schedule_assignment_members**", (r) =>
    json(r, scheduleRows.map((a) => ({ assignment_id: a.id })), scheduleRows.length),
  );
  await page.route("**/rest/v1/schedule_assignments**", (r) => json(r, scheduleRows, scheduleRows.length));
  await page.route("**/rest/v1/time_off_requests**", (r) => json(r, [], 0));
  if (opts.myOpening) {
    const opening = {
      id: "66666666-ffff-4fff-8fff-666666666666",
      project_id: OAKRIDGE,
      planset_id: null,
      opening_code: "W7",
      window_type_id: null,
      label: "Kitchen",
      page_number: 1,
      pin_x: null,
      pin_y: null,
      assigned_window_id: null,
      status: "planned",
      confirmed: true,
      created_at: `${dayISO(-3)}T12:00:00Z`,
      ro_width_in: null,
      ro_height_in: null,
      ro_measured_by: null,
      ro_measured_at: null,
      assigned_to: TEST_USER.id,
      sequence: 1,
      work_started_at: null,
      window_types: null,
      windows: null,
      projects: { id: OAKRIDGE, job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" },
      assignee: { id: TEST_USER.id, display_name: "E2E Fixture", skill_level: 3, role: "installer", active: true },
    };
    await page.route("**/rest/v1/project_openings**", (r) => json(r, [opening], 1));
  }
  await page.route((url) => /\/rest\/v1\/rpc\/clock_in(\?|$)/.test(url.href), (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    world.clockIns.push(body);
    openShift = {
      id: "55555555-eeee-4eee-8eee-555555555555",
      profile_id: TEST_USER.id,
      project_id: body.p_project_id ?? null,
      cost_code_id: body.p_cost_code_id ?? null,
      clock_in_at: new Date().toISOString(),
      clock_out_at: null,
      break_seconds: 0,
      break_started_at: null,
      break_type: null,
      injured: null,
      time_confirmed: null,
      status: "open",
      created_at: new Date().toISOString(),
      note: body.p_note ?? null,
      job_mode: body.p_mode ?? null,
      projects: { job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" },
      cost_codes: { code: "100", label: "Install — windows" },
    };
    return json(r, openShift, null);
  });
  await page.route((url) => /\/rest\/v1\/rpc\/custom_work_command(\?|$)/.test(url.href), (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    world.workCommands.push(body);
    return json(r, "ok", null);
  });
  await page.route((url) => /\/rest\/v1\/rpc\/set_my_ui_design(\?|$)/.test(url.href), (r) => {
    const body = (r.request().postDataJSON() ?? {}) as { p_design?: string };
    world.designWrites.push(body.p_design ?? "");
    return json(r, null, null);
  });
  return world;
}

/** Sign the talk card on screen: pledge, typed name, a stroke, the button. */
export async function signTalk(page: Page, scope = page.locator("body")) {
  await scope.getByText("I read and understood today's talk").click();
  await scope.getByPlaceholder("Full name").fill("E2E Fixture");
  const pad = scope.locator("canvas.sig-canvas");
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2 + 10, { steps: 8 });
  await page.mouse.up();
  await scope.getByRole("button", { name: "Sign today's talk" }).click();
}

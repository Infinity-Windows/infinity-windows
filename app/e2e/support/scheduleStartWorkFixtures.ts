// Two jobs today, and the Schedule tab's Start work on the SECOND one.
//
// Source-only reading (not yet seen in a browser): /my-schedule renders
// Start work as a bare link to "/" (Schedule.tsx), so the tapped row is not
// carried, and Work primes the clock strip from the FIRST of today's
// scheduled jobs (WorkScreen todayJobId → ClockStrip prime).
//
// Built on release1Fixtures.morningFixtures used directly — talk signed,
// paid-time rule off, NO open shift — with only the schedule replaced by two
// published installs for TEST_USER today: OAKRIDGE 07:00, BLACK22 10:00.
// Reads fall through to the canonical fixtures; POSTs to READ_ONLY_RPCS fall
// through; every other write is answered 409 and logged, registered AFTER the
// morning so it answers before the morning's write handlers.

import type { Page, Request } from "@playwright/test";
import { expectedForegroundTouch, type ForegroundTouchPayload } from "./scheduleStartWorkWriteGuard";
import { TEST_USER } from "./supabaseFixtures";
import { dayISO } from "./specHelpers";
import { BLACK22, morningFixtures, OAKRIDGE, type MorningWorld } from "./release1Fixtures";

export const OAKRIDGE_ASSIGNMENT = "bbbbbbbb-1111-4111-8111-111111111111";
export const BLACK22_ASSIGNMENT = "bbbbbbbb-2222-4222-8222-222222222222";

/** Existing screen read-only RPCs, as used by the strict designContinuityFixtures guard. */
export const READ_ONLY_RPCS: readonly string[] = [
  "foreman_contacts_for_me", "can_read_app_update", "crew_goal_summary", "is_partner_user", "list_issues",
  "live_project_ids", "my_pin_status", "server_now", "values_my_owed_count",
  "work_activity_clock_capability", "work_data_snapshot", "work_configuration_snapshot",
];

function assignment(id: string, projectId: string, jobCode: string, name: string, address: string | null, start: string, end: string | null) {
  const today = dayISO(0);
  return {
    id, project_id: projectId, kind: "install", delivery_id: null,
    start_date: today, end_date: today, start_time: start, end_time: end,
    status: "published", color: null, note: null, created_by: null,
    published_at: `${dayISO(-3)}T12:00:00Z`, created_at: `${dayISO(-3)}T12:00:00Z`, updated_at: `${dayISO(-3)}T12:00:00Z`,
    projects: { id: projectId, job_code: jobCode, name, address },
    schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "E2E Fixture" } }],
  };
}

export function twoJobsToday(): Record<string, unknown>[] {
  return [
    assignment(OAKRIDGE_ASSIGNMENT, OAKRIDGE, "OAKRIDGE", "Oakridge Apartments Bldg C", "1200 Oak Ridge Dr, St. George, UT", "07:00", "09:30"),
    assignment(BLACK22_ASSIGNMENT, BLACK22, "BLACK22", "Black Desert", null, "10:00", "15:30"),
  ];
}

export interface Attempt { method: string; url: string }
/** One GET the verification could have made, in the order the browser asked. */
export interface ReadEntry { seq: number; table: string; url: string }
/**
 * What the schedule tables answer, switched by the spec at a moment it
 * chooses (inside the request handler only — no app cache, storage or clock
 * is touched): "pass" = the canonical rows; "fail" = a PostgREST-shaped 503;
 * "hold" = held until release(), then the canonical rows.
 */
export type ScheduleReadMode = "pass" | "fail" | "hold";
export interface ScheduleStartWorkWorld {
  morning: MorningWorld;
  refusedWrites: Attempt[];
  allowedReadPosts: Attempt[];
  /** Existing on-clock foreground presence stamps, distinct from reads/punches. */
  foregroundTouches: (Attempt & { payload: ForegroundTouchPayload })[];
  /** Independent page.on("request") record of every non-read Supabase request. */
  browserWriteAttempts: Attempt[];
  scheduleReads: string[];
  /** schedule_assignment(s|_members) and projects GETs, in sequence. */
  reads: ReadEntry[];
  scheduleMode: ScheduleReadMode;
  /**
   * Every time_off_requests GET whose answer the browser finished receiving
   * (page.on("requestfinished")). listMyPublished reads time off LAST, so one
   * of these per released schedule read is the receipt that its answer came
   * all the way back.
   */
  timeOffAnswered: string[];
  /** Let held schedule reads go. */
  release: () => void;
}

export interface ScheduleStartWorkOptions {
  /** An OAKRIDGE shift already open when the page loads (release1Fixtures). */
  openShift?: boolean;
}

const SUPABASE_PATH = /\/(rest|storage|functions)\/v1\//;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const rpcName = (url: URL) => /\/rest\/v1\/rpc\/([^/?]+)/.exec(url.pathname)?.[1] ?? null;

export async function scheduleStartWorkFixtures(page: Page, opts: ScheduleStartWorkOptions = {}): Promise<ScheduleStartWorkWorld> {
  const morning = await morningFixtures(page, { signed: true, paidTimeFrom: null, openShift: opts.openShift ?? false, newDesignOn: true, scheduleRows: twoJobsToday() });
  let release!: () => void;
  let held = new Promise<void>((resolve) => (release = resolve));
  const world: ScheduleStartWorkWorld = {
    morning, refusedWrites: [], allowedReadPosts: [], foregroundTouches: [], browserWriteAttempts: [], scheduleReads: [], reads: [],
    scheduleMode: "pass",
    timeOffAnswered: [],
    release: () => {
      const go = release;
      held = new Promise<void>((resolve) => (release = resolve));
      go();
    },
  };

  page.on("request", (req: Request) => {
    const url = new URL(req.url());
    if (SUPABASE_PATH.test(url.pathname) && !READ_METHODS.has(req.method())) world.browserWriteAttempts.push({ method: req.method(), url: req.url() });
  });
  page.on("requestfinished", (req: Request) => {
    if (req.method() === "GET" && new URL(req.url()).pathname.endsWith("/rest/v1/time_off_requests")) world.timeOffAnswered.push(req.url());
  });

  await page.route("**/rest/v1/projects**", async (route) => {
    if (route.request().method() === "GET") world.reads.push({ seq: world.reads.length, table: "projects", url: route.request().url() });
    await route.fallback();
  });
  await page.route("**/rest/v1/schedule_assignment**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    const table = url.pathname.split("/rest/v1/")[1] ?? "";
    world.scheduleReads.push(route.request().url());
    world.reads.push({ seq: world.reads.length, table, url: route.request().url() });
    if (world.scheduleMode === "fail") {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "PGRST000", message: "upstream unavailable", details: null, hint: null }),
      });
    }
    if (world.scheduleMode === "hold") await held;
    await route.fallback();
  });

  // Registered last, so it answers first.
  await page.route((url) => SUPABASE_PATH.test(url.pathname), async (route) => {
    const req = route.request();
    if (READ_METHODS.has(req.method())) return route.fallback();
    const fn = rpcName(new URL(req.url()));
    if (req.method() === "POST" && fn && READ_ONLY_RPCS.includes(fn)) {
      world.allowedReadPosts.push({ method: req.method(), url: req.url() });
      return route.fallback();
    }
    // Same narrow foreground exception as designContinuityFixtures. Log it as
    // a write; only this declared existing-shift scenario and exact null GPS
    // payload qualify. An off-clock touch or any extra/non-null field refuses.
    if (req.method() === "POST" && fn === "touch_shift_location") {
      let payload: unknown;
      try { payload = req.postDataJSON(); } catch { /* malformed stays refused */ }
      if (expectedForegroundTouch(opts.openShift === true, payload)) {
        world.foregroundTouches.push({ method: req.method(), url: req.url(), payload });
        return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      }
    }
    world.refusedWrites.push({ method: req.method(), url: req.url() });
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "E2E409", message: "schedule-start-work fixture refuses every write", details: null, hint: null }) });
  });
  return world;
}

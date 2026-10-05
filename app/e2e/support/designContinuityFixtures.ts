// One small, stateful "server" for the classic/new continuity specs
// (new-design-continuity.spec.ts, reveal switch-back review 2026-10-05).
//
// The question those specs answer is narrow: does switching the front door —
// by the person's own Settings choice, or by the owner's master switch — leave
// the saved operational records exactly where they were? A fixture that hands
// each design its own copy of the data cannot answer that, so this one keeps a
// single open shift, a single schedule assignment and a single company row in
// Node, shared by every page (and every browser context) that installs it.
// Everything that changes them changes them INSIDE a request handler, the way
// the database would; the specs never edit this state after a click.
//
// It also keeps the receipts a reviewer needs: every current-shift read that
// was actually served (with the values in it), every preference / master RPC
// body, every break RPC body, and every operational write that was NOT
// expected — those last ones are refused with a 409 so a design switch that
// quietly wrote work data fails loudly instead of passing.
//
// Install order matters (Playwright runs the LAST registered handler first):
// useSupabaseFixtures, then morningFixtures, then installContinuityRoutes.
// openContinuityPage does all three in that order.
//
// What this cannot prove, and the specs do not claim: server authorization,
// distinct real people (every context is the same TEST_USER), realtime
// propagation, offline / unknown-master behaviour, or the installed PWA.

import type { Page, Route } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures as installSupabaseFixtures } from "./supabaseFixtures";
import { dayISO, hideWrongProjectBanner, json, stubGeolocationDenied } from "./specHelpers";
import { INSTALL, OAKRIDGE, morningFixtures } from "./release1Fixtures";

/** The one open shift every design must keep showing. */
export const CONTINUITY_SHIFT_ID = "77777777-1111-4777-8777-777777777777";
/** The one published schedule assignment for today. */
export const CONTINUITY_SCHEDULE_ID = "88888888-2222-4888-8888-888888888888";
/** Break time already on the shift before the spec starts (an earlier break). */
export const PRIOR_BREAK_SECONDS = 600;
export const CONTINUITY_OPENING_ID = "66666666-ffff-4fff-8fff-666666666666";

type Design = "classic" | "new";
type Row = Record<string, unknown>;

/** Explicit read-only RPCs used by these existing screens. Unknown RPCs fail. */
const READ_ONLY_RPCS = new Set([
  "can_read_app_update", "crew_goal_summary", "is_partner_user", "list_issues",
  "live_project_ids", "my_pin_status", "server_now", "values_my_owed_count",
  "work_activity_clock_capability", "work_data_snapshot", "work_configuration_snapshot",
]);
const PREFERENCE_RPC = "set_my_ui_design";

export interface ServedShiftRead {
  session: string;
  id: string;
  project_id: unknown;
  cost_code_id: unknown;
  clock_in_at: unknown;
  break_seconds: unknown;
  break_started_at: unknown;
  break_type: unknown;
}

export interface ContinuityServer {
  /** The saved preference row (profiles.ui_design for TEST_USER). */
  profile: { ui_design: Design };
  /** The saved company row. */
  company: Row;
  /** The saved open shift — mutated only by start_break / end_break handlers. */
  shift: Row;
  /** Snapshot of the shift as it was seeded, for "unchanged" assertions. */
  readonly seededShift: Readonly<Row>;
  schedule: Row[];
  opening: Row;
  /** RPCs the current spec intends to send. Everything else operational is refused. */
  expected: Set<string>;
  log: {
    designRpc: Row[];
    masterRpc: Row[];
    breakStarts: Row[];
    breakEnds: Row[];
    foregroundTouches: Row[];
    /** Answers start_break / end_break actually returned. */
    breakAnswers: Row[];
    shiftReads: ServedShiftRead[];
    profileReads: { session: string; ui_design: Design }[];
    companyReads: { session: string; new_design_r1_enabled: unknown }[];
    scheduleReads: { session: string; rows: Row[] }[];
    openingReads: { session: string; row: Row }[];
    /** Operational writes nobody expected — refused with 409. */
    unexpectedWrites: string[];
    /** Edge-function attempts, served by base fixture but required absent. */
    otherWrites: string[];
  };
}

/** Two hours ago, on the minute, so the shift guard reads an ordinary day. */
function stableClockIn(): string {
  const d = new Date(Date.now() - 2 * 3600_000);
  d.setSeconds(0, 0);
  return d.toISOString();
}

export function createContinuityServer(init: { uiDesign: Design; masterOn?: boolean }): ContinuityServer {
  const clockIn = stableClockIn();
  const shift: Row = {
    id: CONTINUITY_SHIFT_ID,
    client_id: null,
    profile_id: TEST_USER.id,
    project_id: OAKRIDGE,
    cost_code_id: INSTALL,
    clock_in_at: clockIn,
    clock_out_at: null,
    break_seconds: PRIOR_BREAK_SECONDS,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: clockIn,
    note: null,
    injury_note: null,
    job_mode: null,
    review_reason: null,
    projects: { job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" },
    cost_codes: { code: "100", label: "Install — windows" },
  };
  const today = dayISO(0);
  const schedule: Row[] = [
    {
      id: CONTINUITY_SCHEDULE_ID,
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
      updated_at: `${dayISO(-1)}T12:00:00Z`,
      projects: { id: OAKRIDGE, job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C", address: "1200 Oak Ridge Dr, St. George, UT" },
      schedule_assignment_members: [
        { profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "E2E Fixture" } },
        { profile_id: "00000000-0000-4000-8000-0000000000f1", role: "foreman", profiles: { display_name: "Sam" } },
      ],
    },
  ];
  return {
    profile: { ui_design: init.uiDesign },
    company: {
      id: 1,
      evening_nudge_local_time: "17:30:00",
      evening_nudge_enabled: true,
      new_design_r1_enabled: init.masterOn ?? true,
      paid_time_from_start_day_on: null,
    },
    shift,
    seededShift: Object.freeze(structuredClone(shift)),
    schedule,
    opening: {
      id: CONTINUITY_OPENING_ID, project_id: OAKRIDGE, planset_id: null,
      opening_code: "W7", window_type_id: null, label: "Kitchen", page_number: 1,
      pin_x: null, pin_y: null, assigned_window_id: null, status: "planned",
      confirmed: true, created_at: `${dayISO(-3)}T12:00:00Z`, ro_width_in: null,
      ro_height_in: null, ro_measured_by: null, ro_measured_at: null,
      assigned_to: TEST_USER.id, sequence: 1, work_started_at: null,
      window_types: null, windows: null,
      projects: { id: OAKRIDGE, job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" },
      assignee: { id: TEST_USER.id, display_name: "E2E Fixture", skill_level: 3, role: "installer", active: true },
    },
    // Existing app-open courtesy updates last_seen_at even with denied location.
    expected: new Set(["touch_shift_location"]),
    log: {
      designRpc: [],
      masterRpc: [],
      breakStarts: [],
      breakEnds: [],
      foregroundTouches: [],
      breakAnswers: [],
      shiftReads: [],
      profileReads: [],
      companyReads: [],
      scheduleReads: [],
      openingReads: [],
      unexpectedWrites: [],
      otherWrites: [],
    },
  };
}

/** The operational fields a design switch must never move. */
export function shiftIdentity(row: Readonly<Row>) {
  return {
    id: row.id,
    profile_id: row.profile_id,
    project_id: row.project_id,
    cost_code_id: row.cost_code_id,
    clock_in_at: row.clock_in_at,
    clock_out_at: row.clock_out_at,
    status: row.status,
    break_seconds: row.break_seconds,
    break_started_at: row.break_started_at,
    break_type: row.break_type,
  };
}

/** A position in the read log, so a spec can ask "served since this reload?". */
export function readMark(server: ContinuityServer): number {
  return server.log.shiftReads.length;
}

export function shiftReadsSince(server: ContinuityServer, mark: number, session?: string): ServedShiftRead[] {
  return server.log.shiftReads.slice(mark).filter((r) => !session || r.session === session);
}

function refuse(route: Route, server: ContinuityServer, what: string) {
  server.log.unexpectedWrites.push(what);
  return route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ code: "E2E01", message: `continuity fixture refused unexpected write: ${what}` }),
  });
}

function body(route: Route): Row {
  try {
    return (route.request().postDataJSON() ?? {}) as Row;
  } catch {
    return {};
  }
}

function wantsObject(route: Route): boolean {
  return (route.request().headers()["accept"] ?? "").includes("pgrst.object");
}

const rpcMatcher = (name: string) => (url: URL) => new RegExp(`/rest/v1/rpc/${name}(\\?|$)`).test(url.href);

/** The overrides. Call AFTER useSupabaseFixtures and morningFixtures. */
export async function installContinuityRoutes(page: Page, server: ContinuityServer, session: string) {
  // The current open shift, from the one saved row. Everything else asked of
  // time_shifts (recent jobs, history) falls through to morningFixtures.
  await page.route("**/rest/v1/time_shifts**", (route) => {
    const req = route.request();
    if (req.method() !== "GET" && req.method() !== "HEAD") return route.fallback();
    const url = new URL(req.url());
    if (!(url.searchParams.get("status") ?? "").startsWith("in.")) return route.fallback();
    const s = server.shift;
    const open = s.status === "open" || s.status === "needs_finish";
    if (open) {
      server.log.shiftReads.push({
        session,
        id: String(s.id),
        project_id: s.project_id,
        cost_code_id: s.cost_code_id,
        clock_in_at: s.clock_in_at,
        break_seconds: s.break_seconds,
        break_started_at: s.break_started_at,
        break_type: s.break_type,
      });
    }
    const row = open ? structuredClone(s) : null;
    // The legacy reader asks for a list; the paid-clock reader asks maybeSingle.
    if (wantsObject(route)) return json(route, row, row ? 1 : 0);
    return json(route, row ? [row] : [], row ? 1 : 0);
  });

  await page.route("**/rest/v1/schedule_assignments**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const rows = structuredClone(server.schedule);
    server.log.scheduleReads.push({ session, rows });
    return json(route, rows, rows.length);
  });
  await page.route("**/rest/v1/schedule_assignment_members**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return json(route, server.schedule.map((a) => ({ assignment_id: a.id })), server.schedule.length);
  });

  await page.route("**/rest/v1/project_openings**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const row = structuredClone(server.opening);
    server.log.openingReads.push({ session, row });
    return json(route, [row], 1);
  });

  await page.route("**/rest/v1/company_settings**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    server.log.companyReads.push({ session, new_design_r1_enabled: server.company.new_design_r1_enabled });
    const row = structuredClone(server.company);
    return wantsObject(route) ? json(route, row, 1) : json(route, [row], 1);
  });

  // The person's own choice: the saved preference moves before the answer
  // goes back, exactly as the RPC's UPDATE would.
  await page.route(rpcMatcher(PREFERENCE_RPC), (route) => {
    const b = body(route);
    server.log.designRpc.push(b);
    if (b.p_design === "new" || b.p_design === "classic") server.profile.ui_design = b.p_design;
    return json(route, null, null);
  });

  // The owner's master switch: shared company state, answered with the row.
  await page.route(rpcMatcher("set_new_design_switch"), (route) => {
    const b = body(route);
    server.log.masterRpc.push(b);
    if (!server.expected.has("set_new_design_switch")) return refuse(route, server, "rpc/set_new_design_switch");
    if (b.p_release !== "r1" || typeof b.p_enabled !== "boolean") {
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "bad release switch" }) });
    }
    server.company.new_design_r1_enabled = b.p_enabled;
    return json(route, structuredClone(server.company), null);
  });

  // Breaks on the ONE saved shift. A repeat of the same tap (same client id)
  // answers with the row it already made, as the keyed RPC does.
  const startByClient = new Map<string, Row>();
  await page.route(rpcMatcher("start_break"), (route) => {
    const b = body(route);
    server.log.breakStarts.push(b);
    if (!server.expected.has("start_break")) return refuse(route, server, "rpc/start_break");
    if (b.p_shift_id !== server.shift.id) return refuse(route, server, `rpc/start_break on ${String(b.p_shift_id)}`);
    const key = typeof b.p_client_id === "string" ? b.p_client_id : "";
    const seen = key ? startByClient.get(key) : undefined;
    if (seen) return json(route, structuredClone(seen), null);
    if (!server.shift.break_started_at) {
      server.shift.break_started_at = new Date().toISOString();
      server.shift.break_type = typeof b.p_break_type === "string" ? b.p_break_type : "other";
    }
    const answer = structuredClone(server.shift);
    if (key) startByClient.set(key, answer);
    server.log.breakAnswers.push({ rpc: "start_break", ...answer });
    return json(route, answer, null);
  });
  await page.route(rpcMatcher("end_break"), (route) => {
    const b = body(route);
    server.log.breakEnds.push(b);
    if (!server.expected.has("end_break")) return refuse(route, server, "rpc/end_break");
    if (b.p_shift_id !== server.shift.id) return refuse(route, server, `rpc/end_break on ${String(b.p_shift_id)}`);
    const started = server.shift.break_started_at;
    if (typeof started !== "string") {
      return json(route, { outcome: "no_break_running", shift: structuredClone(server.shift) }, null);
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(started)) / 1000));
    server.shift.break_seconds = Number(server.shift.break_seconds ?? 0) + elapsed;
    server.shift.break_started_at = null;
    server.shift.break_type = null;
    const answer = { outcome: "ended", shift: structuredClone(server.shift) };
    server.log.breakAnswers.push({ rpc: "end_break", ...answer.shift });
    return json(route, answer, null);
  });

  // Explicit, narrow foreground exception, matching time_honesty.sql: denied
  // geolocation still stamps last_seen_at, never payroll or activity fields.
  await page.route(rpcMatcher("touch_shift_location"), (route) => {
    const b = body(route);
    server.log.foregroundTouches.push(b);
    if (!server.expected.has("touch_shift_location") ||
      Object.keys(b).sort().join(",") !== "p_accuracy_m,p_lat,p_lng" ||
      b.p_lat !== null || b.p_lng !== null || b.p_accuracy_m !== null) {
      return refuse(route, server, "rpc/touch_shift_location unexpected payload");
    }
    server.shift.last_seen_at = new Date().toISOString();
    return json(route, server.shift.id, null);
  });

  // Every edge-function request is visible in the ledger; the base fixtures
  // answer 501, and the spec must still reject an unexpected attempted call.
  await page.route("**/functions/v1/**", (route) => {
    server.log.otherWrites.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fallback();
  });

  // Registered last, so it screens every REST request. Only explicit read
  // RPCs, expected mutations and preference calls pass; unknown RPCs and all
  // direct table writes are refused. No verb-prefix heuristic.
  await page.route("**/rest/v1/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.split("/rest/v1/")[1]?.split("?")[0] ?? "";
    if (path.startsWith("rpc/")) {
      const fn = path.slice(4);
      if (fn === PREFERENCE_RPC) return route.fallback();
      if (READ_ONLY_RPCS.has(fn) || server.expected.has(fn)) return route.fallback();
      return refuse(route, server, `rpc/${fn}`);
    }
    const method = req.method();
    if (method === "GET" || method === "HEAD") return route.fallback();
    return refuse(route, server, `${method} ${path}`);
  });
}

/**
 * A full-app page on the shared server: the committed fixture sign-in (same
 * TEST_USER every time, role as given), the Release 1 morning with today's
 * talk signed, then this file's overrides.
 */
export async function openContinuityPage(
  page: Page,
  server: ContinuityServer,
  opts: { session: string; role: "installer" | "owner" },
) {
  await installSupabaseFixtures(page, {
    role: opts.role,
    uiDesign: server.profile.ui_design,
    // Read on every profile response: the saved preference as it is NOW.
    profileOverrides: () => {
      server.log.profileReads.push({ session: opts.session, ui_design: server.profile.ui_design });
      return { ui_design: server.profile.ui_design };
    },
  });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, {
    signed: true,
    openShift: true,
    myOpening: true,
    newDesignOn: server.company.new_design_r1_enabled === true,
    scheduleRows: server.schedule,
  });
  await installContinuityRoutes(page, server, opts.session);
}

// Daily-log overlay for new-design-daily-log-continuity.spec.ts (saved-record
// continuity, 2026-10-05).
//
// designRecordContinuityFixtures.ts (and the designContinuityFixtures.ts it
// wraps) are used unchanged: one synthetic OWNER (TEST_USER, role owner), the
// shared shift/company/profile state, the refusal screen for every write nobody
// expected, the forbidden-mutation listener and the completed-transport-write
// observer. This file only adds, AFTER openRecordContinuityPage has installed
// all of that, two narrow routes and seven ledgers:
//
//   - POST rpc/file_daily_log: the simulated server. The UI's request carries
//     no id (dailyLogs.ts fileDailyLog sends p_* fields only), so the id is
//     minted HERE, with crypto.randomUUID(), once, inside the handler, and
//     returned as the saved daily_logs row — the shape toDailyLog(data) reads.
//     Exactly one save is accepted: a fresh job-day at p_expected_revision 0.
//     Anything else is logged and refused with 409, never repaired.
//   - GET daily_logs: serves clones of the one stored row, filtered by the
//     eq / gte / lte params the readers send (listDailyLogs, getDailyLog,
//     listMyDailyLogs, getDailyLogById), with the read-only joins the select
//     names (filer and project only when the select asks for each). A filter
//     operator this file does not understand is answered 400 and logged.
//     Non-GET falls back to the base screen, which refuses and logs it.
//
// Independently of any handler, a `request` listener counts every POST to
// rpc/file_daily_log the page attempted, and a `requestfinished` listener
// counts every one that COMPLETED with a response (any status) — the browser's
// own ledger, not a list filled by the handler.
//
// Fixture conventions, stated so nobody counts them as more:
//   - revision = p_expected_revision + 1 is a mock rule, not verified
//     file_daily_log SQL behaviour.
//   - The filer and project joins are what this fixture answers for
//     `filer:profiles!filed_by(display_name)` and `project:projects(job_code,
//     name)`; they are read-only and compared separately from the saved row.
//   - No PostgREST, RLS, real SQL, auth, installed PWA or physical phone.

import type { Page, Route } from "@playwright/test";
import {
  createRecordContinuityServer,
  openRecordContinuityPage,
  type RecordContinuityServer,
} from "./designRecordContinuityFixtures";
import { TEST_USER } from "./supabaseFixtures";
import { json } from "./specHelpers";

type Row = Record<string, unknown>;

// Independent fixture protocol: reject omitted/extra named arguments instead
// of silently accepting a client/server contract mismatch.
export const DAILY_LOG_RPC_KEYS = [
  "p_project_id", "p_log_date", "p_headline", "p_notes", "p_day_flow", "p_reflection", "p_weather",
  "p_expected_revision", "p_progress_provided", "p_work_stages", "p_stage_progress", "p_covers",
  "p_delays", "p_safety_status", "p_weather_impact", "p_missing_tomorrow", "p_tomorrow_stages",
  "p_tomorrow_crew_expected", "p_tomorrow_plan", "p_units_today", "p_units_to_date",
  "p_units_remaining", "p_units_remaining_detail",
] as const;


/** The read-only join answered for `filer:profiles!filed_by(display_name)`. */
export const FILER = { display_name: "Fixture Owner" } as const;
/** The read-only join answered for `project:projects(job_code, name)`. */
export const PROJECT_JOIN = { job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" } as const;

const RPC_PATH = /\/rest\/v1\/rpc\/file_daily_log(\?|$)/;

export interface ServedDailyLogRead {
  /** "object" for maybeSingle's pgrst.object Accept, "list" otherwise. */
  shape: "object" | "list";
  select: string;
  rows: Row[];
}

export interface DailyLogLedgers {
  /** file_daily_log bodies, exactly as the handler received them. */
  saves: Row[];
  /** Rows the handler answered (the saved row, before any join). */
  answers: Row[];
  /** Saves the handler refused (anything after the one fresh save). */
  refusedSaves: Row[];
  /** Every daily_logs GET this file served, with the rows in it. */
  reads: ServedDailyLogRead[];
  /** daily_logs filters this file does not model — answered 400. Must stay empty. */
  unsupportedReads: string[];
  /** POSTs to rpc/file_daily_log the page attempted (request listener). */
  attempted: string[];
  /** POSTs to rpc/file_daily_log that completed with any status (requestfinished). */
  completed: string[];
}

export interface DailyLogContinuityServer {
  record: RecordContinuityServer;
  /** daily_logs rows, written ONLY by the file_daily_log handler. */
  logs: Row[];
  ledgers: DailyLogLedgers;
}

export function createDailyLogContinuityServer(): DailyLogContinuityServer {
  return {
    record: createRecordContinuityServer(),
    logs: [],
    ledgers: { saves: [], answers: [], refusedSaves: [], reads: [], unsupportedReads: [], attempted: [], completed: [] },
  };
}

/** The saved row as stored, read-only joins removed — what no transition may move. */
export function savedRow(row: Row): Row {
  const copy = structuredClone(row);
  delete copy.filer;
  delete copy.project;
  return copy;
}

function postBody(route: Route): Row | null {
  try {
    const parsed: unknown = route.request().postDataJSON();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Row) : null;
  } catch {
    return null;
  }
}

/** One PostgREST filter value ("eq.x", "gte.x", "lte.x") applied to one column. */
function matches(value: unknown, filter: string): boolean | null {
  const dot = filter.indexOf(".");
  const op = filter.slice(0, dot);
  const operand = filter.slice(dot + 1);
  const v = String(value);
  if (op === "eq") return v === operand;
  if (op === "gte") return v >= operand;
  if (op === "lte") return v <= operand;
  return null;
}

const NOT_FILTERS = new Set(["select", "order", "limit", "offset"]);

async function installDailyLogRoutes(page: Page, server: DailyLogContinuityServer) {
  const { ledgers } = server;

  await page.route("**/rest/v1/daily_logs**", (route) => {
    const req = route.request();
    if (req.method() !== "GET" && req.method() !== "HEAD") return route.fallback();
    const params = new URL(req.url()).searchParams;
    const select = params.get("select") ?? "";
    let rows = server.logs;
    for (const key of new Set(params.keys())) {
      if (NOT_FILTERS.has(key)) continue;
      for (const filter of params.getAll(key)) {
        if (matches("", filter) === null) {
          ledgers.unsupportedReads.push(`${key}=${filter}`);
          return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: `fixture does not model ${key}=${filter}` }) });
        }
        rows = rows.filter((r) => matches(r[key], filter));
      }
    }
    // Clones only: a read never hands out, or changes, the stored row.
    const served = rows.map((r) => ({
      ...structuredClone(r),
      ...(select.includes("filer:") ? { filer: { ...FILER } } : {}),
      ...(select.includes("project:projects") ? { project: { ...PROJECT_JOIN } } : {}),
    }));
    const object = (req.headers()["accept"] ?? "").includes("pgrst.object");
    ledgers.reads.push({ shape: object ? "object" : "list", select, rows: structuredClone(served) });
    if (object) return json(route, served[0] ?? null, served.length);
    return json(route, served, served.length);
  });

  // The one expected save. Every mutation of `server.logs` happens here, in
  // answer to the UI's own request, and nowhere else.
  await page.route((url) => RPC_PATH.test(url.href), (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = postBody(route) ?? {};
    ledgers.saves.push(structuredClone(body));
    const exactKeys = JSON.stringify(Object.keys(body).sort()) === JSON.stringify([...DAILY_LOG_RPC_KEYS].sort());
    const fresh = exactKeys && server.logs.length === 0 && ledgers.answers.length === 0 &&
      !("id" in body) && !("p_id" in body) && body.p_expected_revision === 0 &&
      typeof body.p_project_id === "string" && typeof body.p_log_date === "string" &&
      typeof body.p_notes === "string" && body.p_progress_provided === true;
    if (!fresh) {
      ledgers.refusedSaves.push(structuredClone(body));
      return route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ code: "E2E02", message: "daily-log continuity fixture accepts exactly one fresh save" }) });
    }
    const now = new Date().toISOString();
    const row: Row = {
      id: crypto.randomUUID(),
      project_id: body.p_project_id,
      log_date: body.p_log_date,
      revision: (body.p_expected_revision as number) + 1,
      headline: body.p_headline ?? null,
      notes: body.p_notes,
      day_flow: body.p_day_flow ?? null,
      reflection: body.p_reflection ?? null,
      weather: body.p_weather ?? null,
      customer_visible: false,
      customer_visible_at: null,
      filed_by: TEST_USER.id,
      updated_by: TEST_USER.id,
      created_at: now,
      updated_at: now,
      job_name: null,
      work_stages: body.p_work_stages ?? null,
      stage_progress: body.p_stage_progress ?? null,
      covers: body.p_covers ?? null,
      delays: body.p_delays ?? null,
      safety_status: body.p_safety_status ?? null,
      weather_impact: body.p_weather_impact ?? null,
      missing_tomorrow: body.p_missing_tomorrow ?? null,
      tomorrow_stages: body.p_tomorrow_stages ?? null,
      tomorrow_crew_expected: body.p_tomorrow_crew_expected ?? null,
      tomorrow_plan: body.p_tomorrow_plan ?? null,
      units_today: body.p_units_today ?? null,
      units_to_date: body.p_units_to_date ?? null,
      units_remaining: body.p_units_remaining ?? null,
      units_remaining_detail: body.p_units_remaining_detail ?? null,
    };
    server.logs.push(row);
    ledgers.answers.push(structuredClone(row));
    return json(route, structuredClone(row), null);
  });
}

/**
 * openRecordContinuityPage as the synthetic owner (no photo / crew overlays),
 * then this file's daily-log routes and the browser-side save ledgers.
 */
export async function openDailyLogContinuityPage(page: Page, server: DailyLogContinuityServer, opts: { session: string }) {
  await openRecordContinuityPage(page, server.record, { session: opts.session });
  await installDailyLogRoutes(page, server);
  const isSave = (method: string, url: string) => method === "POST" && RPC_PATH.test(url);
  page.on("request", (req) => {
    if (isSave(req.method(), req.url())) server.ledgers.attempted.push(new URL(req.url()).pathname);
  });
  page.on("requestfinished", (req) => {
    if (isSave(req.method(), req.url())) server.ledgers.completed.push(new URL(req.url()).pathname);
  });
}

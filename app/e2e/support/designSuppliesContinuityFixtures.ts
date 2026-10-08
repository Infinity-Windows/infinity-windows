// Supplies overlay for new-design-supplies-continuity.spec.ts (saved-record
// continuity, 2026-10-05). FIXTURE ONLY: no SQL, RLS, auth or PostgREST runs.
//
// Built on the UNCHANGED base designContinuityFixtures.ts (openContinuityPage,
// role owner), the same way designQcContinuityFixtures.ts is — not on a record
// helper whose forbidden-write list would have to be loosened. Everything here
// is registered AFTER the base install, so it wins only for the exact routes it
// names; every other REST write still meets the base refusal screen
// (base.log.unexpectedWrites) and every other read is the base's.
//
//   - POST rpc/take_supply: the simulated server, shaped on migration
//     20260830000000_take_supply_idempotent.sql. The CLIENT key is the app's
//     (offlineWrites.ts takeSupplyOffline → newClientId), sent as p_client_id.
//     The SQL inserts ONE movements row (supply_id, event 'took', project_id,
//     qty, actor = auth.uid()::text, client_id) and then lowers on_hand,
//     floored at zero, and RETURNS THE UPDATED SUPPLIES ROW — not a movement
//     id, not a revision. So this handler answers with the supply row, and the
//     movement's own id is minted here, in the handler, only when the one
//     accepted take lands. It is a synthetic stand-in for the column default,
//     not a protocol id the app ever sees on the wire. Exactly one well-formed
//     take is accepted; anything else is logged and refused with 409. No
//     supply_orders are seeded, so the SQL's pull-list tick has nothing to
//     flip and is not modelled. This handler is the only place the supply row
//     or the movement log ever changes.
//   - GET supplies (listSupplies: select=*, order=name.asc) and GET movements
//     (listSupplyTakes: the exact select, supply_id=eq.<the seeded supply>,
//     event=eq.took, order=created_at.desc): served from that state, cloned.
//     Any other query on either table is answered 400 and logged, so an
//     unexpected read can never feed rows into the history or the shelf.
//   - GET profiles with select "id,display_name" and id=in.(TEST_USER): the
//     history's actor-name lookup only. Every other profiles read falls back to
//     the base, so the profile / design preference stays the base's live row.
//
// A `request` listener and a `requestfinished` listener count every POST to
// rpc/take_supply attempted and completed — the browser's own ledger, kept
// apart from what the handler itself recorded.
//
// Limits: one synthetic OWNER in one browser context; the movement id and
// event are fixture answers correlated to the request key by this handler, not
// by the database; no stock authority, idempotent-retry replay, offline outbox,
// installed PWA or physical inventory is exercised.

import { randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import {
  createContinuityServer,
  openContinuityPage,
  type ContinuityServer,
} from "./designContinuityFixtures";
import { TEST_USER, jobFixtures } from "./supabaseFixtures";
import { json } from "./specHelpers";

type Row = Record<string, unknown>;

/** The one catalog supply the shelf starts with — input, not a saved take. */
export const SUPPLY_ID = "aaaaaaaa-5555-4aaa-8aaa-aaaaaaaa5555";
export const SUPPLY_NAME = "Continuity sealant, almond";
export const ON_HAND_BEFORE = 40;
export const TAKE_QTY = 2;
export const ON_HAND_AFTER = 38;
/** The real BLACK22 row the base fixture serves in the projects list. */
export const TAKE_PROJECT_ID = jobFixtures().find((j) => j.jobCode === "BLACK22")!.projectId;
/** The actor name the history's profiles lookup is answered with. */
export const ACTOR_NAME = "E2E Fixture";
/** Exactly the arguments lib/ops.ts takeSupply sends. */
export const TAKE_RPC_KEYS = ["p_client_id", "p_project", "p_qty", "p_supply"] as const;
/** The columns listSupplyTakes selects (postgrest-js strips the spaces). */
export const MOVEMENT_SELECT = "id,project_id,qty,actor,created_at";

const RPC_PATH = /\/rest\/v1\/rpc\/take_supply(\?|$)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SuppliesRead { table: string; query: string; rows: Row[] }

export interface SuppliesContinuityServer {
  base: ContinuityServer;
  /** The one supplies row. Changed ONLY by the take_supply handler. */
  supply: Row;
  /** movements rows — written ONLY by the take_supply handler. */
  movements: Row[];
  ledgers: {
    /** take_supply bodies, exactly as the handler received them. */
    saves: Row[];
    /** The updated supply rows the handler answered with. */
    answers: Row[];
    /** Bodies the handler refused. Must stay empty. */
    refusedSaves: Row[];
    /** Every read this overlay served. */
    reads: SuppliesRead[];
    /** Queries this overlay does not model — answered 400. Must stay empty. */
    unsupportedReads: string[];
    /** POSTs to rpc/take_supply attempted (request listener). */
    attempted: string[];
    /** POSTs to rpc/take_supply completed with any status (requestfinished). */
    completed: string[];
  };
}

export function createSuppliesContinuityServer(): SuppliesContinuityServer {
  // The owner starts on classic with the master switch on, and moves both only
  // through the real Settings controls; the base refuses the switch otherwise.
  const base = createContinuityServer({ uiDesign: "classic", masterOn: true });
  base.expected.add("set_new_design_switch");
  return {
    base,
    supply: {
      id: SUPPLY_ID,
      name: SUPPLY_NAME,
      unit: "tube",
      home_location_id: null,
      home_container_id: null,
      home_note: null,
      on_hand: ON_HAND_BEFORE,
      // A date with neither 38 nor 40 in it, so the on-hand number is unambiguous.
      last_counted_at: "2026-09-29T15:00:00.000Z",
      created_at: "2026-09-01T15:00:00.000Z",
    },
    movements: [],
    ledgers: { saves: [], answers: [], refusedSaves: [], reads: [], unsupportedReads: [], attempted: [], completed: [] },
  };
}

/** The projection listSupplyTakes reads of one movement row. */
export function takeProjection(m: Readonly<Row>): Row {
  return { id: m.id, project_id: m.project_id, qty: m.qty, actor: m.actor, created_at: m.created_at };
}

const isRead = (route: Route) => route.request().method() === "GET" || route.request().method() === "HEAD";

/** True only when the query string is exactly `expected` — one value per key, nothing extra. */
function exactQuery(route: Route, expected: Record<string, string>): boolean {
  const params = new URL(route.request().url()).searchParams;
  const keys = [...params.keys()];
  if (keys.length !== Object.keys(expected).length) return false;
  for (const [key, want] of Object.entries(expected)) {
    const got = params.getAll(key);
    if (got.length !== 1) return false;
    if ((key === "select" ? got[0].replace(/\s+/g, "") : got[0]) !== want) return false;
  }
  return true;
}

function unsupported(route: Route, server: SuppliesContinuityServer, table: string) {
  const what = `${route.request().method()} ${table}${new URL(route.request().url()).search}`;
  server.ledgers.unsupportedReads.push(what);
  return route.fulfill({ status: 400, contentType: "application/json",
    body: JSON.stringify({ message: `Supplies fixture does not model ${what}` }) });
}

function serve(route: Route, server: SuppliesContinuityServer, table: string, rows: Row[]) {
  const served = structuredClone(rows);
  server.ledgers.reads.push({ table, query: new URL(route.request().url()).search, rows: structuredClone(served) });
  return json(route, served, served.length);
}

async function installSuppliesRoutes(page: Page, server: SuppliesContinuityServer) {
  // listSupplies, and nothing else.
  await page.route("**/rest/v1/supplies**", (route) => {
    if (!isRead(route)) return route.fallback();
    if (!exactQuery(route, { select: "*", order: "name.asc" })) return unsupported(route, server, "supplies");
    return serve(route, server, "supplies", [server.supply]);
  });

  // listSupplyTakes for the seeded supply, and nothing else.
  await page.route("**/rest/v1/movements**", (route) => {
    if (!isRead(route)) return route.fallback();
    if (!exactQuery(route, {
      select: MOVEMENT_SELECT, supply_id: `eq.${SUPPLY_ID}`, event: "eq.took", order: "created_at.desc",
    })) return unsupported(route, server, "movements");
    const rows = server.movements
      .filter((m) => m.supply_id === SUPPLY_ID && m.event === "took")
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(takeProjection);
    return serve(route, server, "movements", rows);
  });

  // The history's actor-name lookup only; every other profiles read is the base's.
  await page.route("**/rest/v1/profiles**", (route) => {
    if (!isRead(route) || !exactQuery(route, { select: "id,display_name", id: `in.(${TEST_USER.id})` })) {
      return route.fallback();
    }
    return serve(route, server, "profiles", [{ id: TEST_USER.id, display_name: ACTOR_NAME }]);
  });

  // The one expected take. All supply and movement state changes happen here,
  // in answer to the UI's own request, and nowhere else.
  await page.route((url) => RPC_PATH.test(url.href), (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    let body: Row = {};
    try {
      const parsed: unknown = route.request().postDataJSON();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Row;
    } catch {
      body = {};
    }
    server.ledgers.saves.push(structuredClone(body));
    const valid = JSON.stringify(Object.keys(body).sort()) === JSON.stringify([...TAKE_RPC_KEYS]) &&
      typeof body.p_client_id === "string" && UUID.test(body.p_client_id) &&
      body.p_supply === SUPPLY_ID && body.p_project === TAKE_PROJECT_ID && body.p_qty === TAKE_QTY &&
      server.movements.length === 0;
    if (!valid) {
      server.ledgers.refusedSaves.push(structuredClone(body));
      return route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ code: "E2E04", message: "Supplies continuity fixture accepts exactly one well-formed take" }) });
    }
    // The movement row first, then the count — the SQL's order.
    server.movements.push({
      id: randomUUID(), supply_id: SUPPLY_ID, event: "took", project_id: TAKE_PROJECT_ID,
      qty: TAKE_QTY, actor: TEST_USER.id, client_id: body.p_client_id, created_at: new Date().toISOString(),
    });
    const onHand = server.supply.on_hand;
    server.supply.on_hand = onHand == null ? null : Math.max(Number(onHand) - TAKE_QTY, 0);
    const answer = structuredClone(server.supply);
    server.ledgers.answers.push(structuredClone(answer));
    return json(route, answer, null);
  });
}

/** openContinuityPage as the synthetic owner, then the Supplies overlay and the browser save ledgers. */
export async function openSuppliesContinuityPage(page: Page, server: SuppliesContinuityServer, opts: { session: string }) {
  await openContinuityPage(page, server.base, { session: opts.session, role: "owner" });
  await installSuppliesRoutes(page, server);
  const isSave = (method: string, url: string) => method === "POST" && RPC_PATH.test(url);
  page.on("request", (req) => {
    if (isSave(req.method(), req.url())) server.ledgers.attempted.push(new URL(req.url()).pathname);
  });
  page.on("requestfinished", (req) => {
    if (isSave(req.method(), req.url())) server.ledgers.completed.push(new URL(req.url()).pathname);
  });
}

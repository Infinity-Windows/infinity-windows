// Saved-record overlays for new-design-record-continuity.spec.ts
// (saved-record continuity, 2026-10-05).
//
// designContinuityFixtures.ts keeps one shift, one schedule row and one company
// row in Node and refuses every operational write it did not expect. This file
// does not change that helper. It wraps it, and only AFTER openContinuityPage
// has installed it adds a few narrow overlays, each for an explicit route and
// method, each with its own ledger:
//
//   - photo transport (storage objects + attachments): a dead zone the spec
//     switches on after the photo sheet is open and never switches off. Every
//     storage or attachments WRITE is aborted the way a dead zone fails and
//     logged as an attempt; none is ever fulfilled.
//   - list_my_worked_jobs (POST only, as supabase-js sends a default rpc): a
//     `language sql stable` SELECT over projects
//     (20260995000000_installer_gallery.sql:297-308), answered here as a read
//     and counted separately. Any other method falls back to the base refusal.
//   - crew records: record_crew_work is stored ONCE under the app's own p_id,
//     the way crew-unit-records.spec.ts stores it; crew_work_records and
//     custom_work_units GETs serve that state back. Non-GETs on those tables
//     fall back to the base screen, which refuses and logs them.
//
// Independently of any handler, a synchronous `requestfinished` observer
// (installed for every test, photo or crew) logs each non-GET/HEAD storage
// object write (signing excluded) and each non-GET/HEAD attachments request
// that actually COMPLETED with a response — any status, a 409 included. A
// handler abort ends in `requestfailed`, never here, so this ledger is the
// browser's own account of what got through, not a list filled by a handler.
//
// Playwright runs the LAST registered handler first, so these win over the
// base screen for exactly the routes they name; everything else still meets
// the base refusal ledger unchanged.
//
// Fixture limit, stated so nobody counts it as more: one synthetic OWNER
// identity (TEST_USER, role owner) in one browser context. The owner's own
// master switch and the owner's own personal preference are the same fixture
// person — no second authenticated person is invented. No server authorization,
// real SQL/RLS, real Storage, installed PWA, service-worker relaunch or
// physical phone.

import type { Page, Route } from "@playwright/test";
import {
  createContinuityServer,
  openContinuityPage,
  type ContinuityServer,
} from "./designContinuityFixtures";
import { TEST_USER } from "./supabaseFixtures";
import { json } from "./specHelpers";
import { OAKRIDGE } from "./release1Fixtures";

type Row = Record<string, unknown>;

/** Operational mutations no step of these specs may ever attempt. */
export const FORBIDDEN_MUTATIONS = [
  "clock_in", "custom_work_command", "finish_unit", "record_stage_contributors",
  "correct_stage_contributors", "record_qc_decision",
] as const;

export interface RecordLedgers {
  /** Storage / attachments writes the app tried. Every one was aborted. */
  transportWriteAttempts: string[];
  /**
   * Storage / attachments writes the browser saw COMPLETE (requestfinished),
   * any status. Observed, never pushed by a route handler. Must stay empty.
   */
  transportCompletedWrites: string[];
  /** Storage / attachments reads (aborted while the dead zone is on). */
  transportReads: string[];
  /** list_my_worked_jobs answers served. */
  workedJobsReads: number;
  /** record_crew_work bodies, exactly as sent. */
  crewSaves: Row[];
  /** Ids served on every crew_work_records GET. */
  crewRecordReads: string[][];
  /** POSTs to FORBIDDEN_MUTATIONS, from a request listener (independent of routing). */
  forbiddenAttempts: string[];
}

export interface RecordContinuityServer {
  base: ContinuityServer;
  transport: { down: boolean };
  /** Crew records, written only by the record_crew_work handler. */
  crewRecords: Row[];
  crewUnits: Row[];
  ledgers: RecordLedgers;
}

export function createRecordContinuityServer(): RecordContinuityServer {
  // The owner starts on classic with the master switch on; the specs move both
  // only through the real Settings controls.
  const base = createContinuityServer({ uiDesign: "classic", masterOn: true });
  base.expected.add("set_new_design_switch");
  return {
    base,
    transport: { down: false },
    crewRecords: [],
    crewUnits: [],
    ledgers: {
      transportWriteAttempts: [],
      transportCompletedWrites: [],
      transportReads: [],
      workedJobsReads: 0,
      crewSaves: [],
      crewRecordReads: [],
      forbiddenAttempts: [],
    },
  };
}

function counted(route: Route, rows: unknown[]) {
  return json(route, rows, rows.length);
}

/** A storage-object write (signing excluded) or an attachments write, by method + path. */
function isTransportWrite(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (pathname.includes("/rest/v1/attachments")) return true;
  return pathname.includes("/storage/v1/object/") && !pathname.includes("/object/sign/");
}

async function installPhotoTransport(page: Page, server: RecordContinuityServer) {
  const { ledgers, transport } = server;
  await page.route("**/storage/v1/object/**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const signing = url.pathname.includes("/object/sign/");
    const write = !signing && req.method() !== "GET" && req.method() !== "HEAD";
    if (write) {
      ledgers.transportWriteAttempts.push(`${req.method()} ${url.pathname}`);
      return route.abort("internetdisconnected");
    }
    ledgers.transportReads.push(`${req.method()} ${url.pathname}`);
    if (transport.down) return route.abort("internetdisconnected");
    return signing ? json(route, { signedURL: "/fixture.jpg" }) : route.fallback();
  });
  await page.route("**/rest/v1/attachments**", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() !== "GET" && req.method() !== "HEAD") {
      ledgers.transportWriteAttempts.push(`${req.method()} ${url.pathname}`);
      return route.abort("internetdisconnected");
    }
    ledgers.transportReads.push(`${req.method()} ${url.pathname}`);
    if (transport.down) return route.abort("internetdisconnected");
    return counted(route, []);
  });
  await page.route((url) => /\/rest\/v1\/rpc\/list_my_worked_jobs(\?|$)/.test(url.href), (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    ledgers.workedJobsReads++;
    return counted(route, [{ id: OAKRIDGE, job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" }]);
  });
}

async function installCrewRecords(page: Page, server: RecordContinuityServer) {
  const { ledgers } = server;
  // The crew picker's people (crew-unit-records.spec.ts:8-15), owner-side.
  await page.route("**/rest/v1/profiles**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (!new URL(route.request().url()).searchParams.get("select")?.includes("is_partner")) return route.fallback();
    return counted(route, [
      { id: "00000000-0000-4000-8000-000000000002", display_name: "Fixture Installer", role: "installer", active: true, is_partner: false },
      { id: "00000000-0000-4000-8000-000000000003", display_name: "Fixture Helper", role: "installer", active: true, is_partner: false },
      { id: TEST_USER.id, display_name: "Fixture Owner", role: "owner", active: true, is_partner: false },
    ]);
  });
  for (const table of ["custom_work_sessions", "custom_work_types", "custom_work_history"]) {
    await page.route(`**/rest/v1/${table}**`, (route) =>
      route.request().method() === "GET" ? counted(route, []) : route.fallback());
  }
  await page.route("**/rest/v1/custom_work_units**", (route) =>
    route.request().method() === "GET" ? counted(route, structuredClone(server.crewUnits)) : route.fallback());
  await page.route("**/rest/v1/crew_work_records**", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const rows = structuredClone(server.crewRecords);
    ledgers.crewRecordReads.push(rows.map((r) => String(r.id)));
    return counted(route, rows);
  });
  // The one expected save. The record is stored once under the p_id the app
  // generated; a repeat of that id answers the same unit and stores nothing.
  await page.route((url) => /\/rest\/v1\/rpc\/record_crew_work(\?|$)/.test(url.href), (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    let body: Row;
    try {
      body = (route.request().postDataJSON() ?? {}) as Row;
    } catch {
      body = {};
    }
    ledgers.crewSaves.push(structuredClone(body));
    const data = body.p_data as Row | undefined;
    const unit = data?.unit as Row | undefined;
    if (typeof body.p_id !== "string" || !data || !unit || typeof unit.id !== "string" || !Array.isArray(data.people)) {
      return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "bad crew record" }) });
    }
    if (!server.crewRecords.some((r) => r.id === body.p_id)) {
      server.crewUnits.push({ ...unit, created_by: TEST_USER.id, revision: 1 });
      server.crewRecords.push({
        id: body.p_id, project_id: OAKRIDGE, unit_id: unit.id, filed_by: TEST_USER.id, ...data,
        created_at: new Date().toISOString(),
        people: (data.people as unknown[]).map((profile_id) => ({ profile_id })),
      });
    }
    return json(route, unit.id, null);
  });
}

/**
 * openContinuityPage as the synthetic owner, then the overlays this test needs.
 * The base helper and its refusal screen are installed first and unchanged.
 * The completed-transport-write and forbidden-mutation observers are installed
 * unconditionally, so both the photo and the crew test are covered.
 */
export async function openRecordContinuityPage(
  page: Page,
  server: RecordContinuityServer,
  opts: { session: string; photo?: boolean; crew?: boolean },
) {
  await openContinuityPage(page, server.base, { session: opts.session, role: "owner" });
  if (opts.photo) await installPhotoTransport(page, server);
  if (opts.crew) await installCrewRecords(page, server);
  page.on("requestfinished", (req) => {
    const pathname = new URL(req.url()).pathname;
    if (isTransportWrite(req.method(), pathname)) server.ledgers.transportCompletedWrites.push(`${req.method()} ${pathname}`);
  });
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(req.url())?.[1];
    if (fn && (FORBIDDEN_MUTATIONS as readonly string[]).includes(fn)) server.ledgers.forbiddenAttempts.push(fn);
  });
}

// --- Native IndexedDB observation of the photo outbox ----------------------

/**
 * One wops-write-outbox entry as stored, effective metadata overlay applied,
 * checked RAW against the serialized schema (outbox-core.ts makeEntry +
 * serializeEntry) — never through deserializeEntry, which fills defaults and
 * turns "sending" into "queued". Every departure is listed in `problems`.
 */
export interface ObservedOutboxEntry {
  id: string;
  problems: string[];
  overlayPresent: boolean;
  op: unknown;
  ownerId: unknown;
  createdAt: unknown;
  hasBlob: unknown;
  /** "absent" when the key is missing, else JSON of the raw value. */
  dependsOnRaw: string;
  payloadJson: string;
  status: unknown;
  attemptCount: unknown;
  nextAttemptAt: unknown;
  /** The raw value, or "absent" when the key is missing (a schema problem). */
  lastError: unknown;
  blobPresent: boolean;
  blobSize: number | null;
  blobType: string | null;
  blobSha256: string | null;
}

/**
 * Read the app's existing outbox with one readonly transaction, and only after
 * it completes. Never creates, upgrades, migrates, writes or deletes: if the
 * database does not exist, the open would be an upgrade, so that versionchange
 * transaction is aborted at once (which also discards the would-be database)
 * and the read fails. Once the open has been rejected — blocked, error or
 * upgrade — a later success closes its handle rather than leaking it; the
 * resolved handle is closed in every path.
 */
export async function readWriteOutbox(page: Page): Promise<ObservedOutboxEntry[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let upgrade = false;
      let rejected = false;
      const fail = (error: Error) => {
        if (rejected) return;
        rejected = true;
        reject(error);
      };
      const req = indexedDB.open("wops-write-outbox");
      req.onupgradeneeded = () => {
        upgrade = true;
        req.transaction?.abort();
      };
      req.onsuccess = () => {
        if (upgrade || rejected) {
          req.result.close();
          fail(new Error("wops-write-outbox open asked for an upgrade or was already refused; handle closed"));
        } else {
          resolve(req.result);
        }
      };
      req.onerror = () => fail(upgrade
        ? new Error("wops-write-outbox does not exist; refused to create it")
        : req.error ?? new Error("wops-write-outbox open failed"));
      req.onblocked = () => fail(new Error("wops-write-outbox open blocked"));
    });
    try {
      db.onversionchange = () => db.close();
      for (const name of ["entries", "metadata"]) {
        if (!db.objectStoreNames.contains(name)) throw new Error(`wops-write-outbox has no ${name} store`);
      }
      const tx = db.transaction(["entries", "metadata"], "readonly");
      const rowsReq = tx.objectStore("entries").getAll();
      const metasReq = tx.objectStore("metadata").getAll();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("outbox read failed"));
        tx.onabort = () => reject(tx.error ?? new Error("outbox read aborted"));
      });
      const rows = rowsReq.result as { id: unknown; meta: unknown; blob: unknown }[];
      const overlays = new Map((metasReq.result as { id: string; meta: unknown }[]).map((m) => [m.id, m]));
      const nonEmpty = (v: unknown) => typeof v === "string" && v.length > 0;
      const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
      const out = [];
      for (const row of rows) {
        const problems: string[] = [];
        const id = typeof row.id === "string" ? row.id : "";
        const overlay = overlays.get(id);
        const metaText = overlay ? overlay.meta : row.meta;
        let e: Record<string, unknown> = {};
        try {
          const parsed: unknown = typeof metaText === "string" ? JSON.parse(metaText) : null;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) e = parsed as Record<string, unknown>;
          else problems.push("effective meta is not an object");
        } catch {
          problems.push("effective meta is not JSON");
        }
        // The serialized schema, field by field, as makeEntry writes it and
        // applyFailure / markSending rewrite it. No defaults are filled in.
        if (e.v !== 1) problems.push("serialization version is not 1");
        if (!nonEmpty(id) || e.id !== id) problems.push("id missing or not the row's id");
        if (e.op !== "photo_upload") problems.push("op is not photo_upload");
        if (!nonEmpty(e.ownerId)) problems.push("ownerId missing or empty");
        const p = e.payload;
        if (!p || typeof p !== "object" || Array.isArray(p)) {
          problems.push("payload is not an object");
        } else {
          const payload = p as Record<string, unknown>;
          for (const key of ["projectId", "createdBy", "kind", "path"]) {
            if (!nonEmpty(payload[key])) problems.push(`payload.${key} missing or empty`);
          }
        }
        if (!finite(e.createdAt)) problems.push("createdAt not a finite number");
        if (e.status !== "queued" && e.status !== "sending" && e.status !== "failed") problems.push("status not queued|sending|failed");
        if (!Number.isSafeInteger(e.attemptCount) || (e.attemptCount as number) < 0) problems.push("attemptCount not a nonnegative integer");
        if (!finite(e.nextAttemptAt)) problems.push("nextAttemptAt not a finite number");
        if (!("lastError" in e) || (e.lastError !== null && typeof e.lastError !== "string")) problems.push("lastError not string|null");
        if ("dependsOn" in e && e.dependsOn !== null && typeof e.dependsOn !== "string") problems.push("dependsOn not string|null");
        if (e.hasBlob !== true) problems.push("hasBlob is not true");
        const blob = row.blob instanceof Blob ? row.blob : null;
        if (!blob) problems.push("no stored Blob");
        let digest: string | null = null;
        if (blob) {
          const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
          digest = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
        }
        out.push({
          id,
          problems,
          overlayPresent: Boolean(overlay),
          op: e.op ?? null,
          ownerId: e.ownerId ?? null,
          createdAt: e.createdAt ?? null,
          hasBlob: e.hasBlob ?? null,
          dependsOnRaw: "dependsOn" in e ? JSON.stringify(e.dependsOn) : "absent",
          payloadJson: JSON.stringify(e.payload ?? null),
          status: e.status ?? null,
          attemptCount: e.attemptCount ?? null,
          nextAttemptAt: e.nextAttemptAt ?? null,
          lastError: "lastError" in e ? e.lastError : "absent",
          blobPresent: blob !== null,
          blobSize: blob ? blob.size : null,
          blobType: blob ? blob.type : null,
          blobSha256: digest,
        });
      }
      return out;
    } finally {
      db.close();
    }
  });
}

/**
 * What a design switch must never move. Retry metadata (status, attemptCount,
 * nextAttemptAt, lastError) is left out of this comparison on purpose, but it
 * is still schema-checked on every read through `problems`, which is included.
 */
export function outboxIdentity(e: ObservedOutboxEntry) {
  return {
    id: e.id,
    problems: e.problems,
    op: e.op,
    ownerId: e.ownerId,
    createdAt: e.createdAt,
    hasBlob: e.hasBlob,
    dependsOnRaw: e.dependsOnRaw,
    payloadJson: e.payloadJson,
    blobPresent: e.blobPresent,
    blobSize: e.blobSize,
    blobType: e.blobType,
    blobSha256: e.blobSha256,
  };
}

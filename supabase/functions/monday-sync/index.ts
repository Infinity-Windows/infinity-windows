// monday-sync: pull up-and-coming jobs from the Monday.com "Ops Gantt Chart"
// board into the monday_jobs staging table (owner decisions, 2026-08-11).
//
// Source: groups "Ready to Schedule" + "Scheduled" — per the office's own
// status rules those are jobs with payment and product in hand. Rows are
// PROPOSALS the office reviews on the Jobs page (Monday has no job codes);
// after a project is built from a row, this sync keeps the project's start
// and end dates fresh from Monday's timeline UNTIL install work starts,
// then the app owns the job.
//
// Trigger: invoked by the app whenever a lead opens the Jobs page, but
// self-THROTTLED to one real sync per 10 minutes (last synced_at wins), so
// polling stays ~15-minute-fresh during working hours at effectively zero
// cost. Point a Supabase Cron schedule at this URL later for off-hours
// freshness; the throttle already makes that safe. Pass { force: true } to
// bypass the throttle (the manual "Sync now" button).
//
// Auth: verify_jwt = true (signed-in callers only); writes use the service
// role internally. Secrets from Deno.env: MONDAY_API_TOKEN, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.
//
// THE BOARD BELONGS TO STG WINDOWS, NOT TO US. This app is a guest on somebody
// else's board and every GraphQL operation it sends is a read — never a write
// of any kind, never a file upload, never a column change. Downloading a file
// through the one-hour public_url Monday hands out is a read and is allowed.
// app/src/lib/mondayReadOnly.test.ts fails the build if the word for a GraphQL
// write ever appears in this file, so the rule cannot be softened by accident.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";
import { verifyCaller } from "../_shared/auth.ts";
import { readBodyCapped } from "../_shared/bytes.ts";
// The pure half — the two file column ids, what Monday's answer becomes, and
// the two decisions the app's own test suite has to be able to reach: which
// assets a pull may fetch, and which documents carry a price.
import {
  FILES_COLUMN_ID,
  filesOf,
  looksLikeMoneyDocument,
  MEASURE_COLUMN_ID,
  type MondayFileItem,
  pullAllowList,
  type StagedFile,
} from "../_shared/mondayFiles.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_API_TOKEN = Deno.env.get("MONDAY_API_TOKEN") ?? "";

const BOARD_ID = "8185408239"; // Ops Gantt Chart ("STG Windows" workspace)
const GROUP_IDS = ["group_mkwrzygn", "group_mkwrz2sm"]; // Ready to Schedule, Scheduled
const THROTTLE_MS = 10 * 60 * 1000;

// The board's two file columns live in _shared/mondayFiles.ts beside the rules
// that read them. They are asked for one column at a time under a GraphQL
// alias, because asking for both column ids at once returns one flat list that
// does not say which column each file came from.

/** A board row, with the file columns MondayFileItem already describes. */
interface MondayItem extends MondayFileItem {
  name: string;
  group: { id: string; title: string };
  column_values: { id: string; text: string | null; value: string | null }[];
}

/** The asset fields both board reads ask for. No download link, on purpose. */
const ASSET_FIELDS = "id name file_extension file_size created_at";

function col(item: MondayItem, id: string): { text: string | null; value: string | null } {
  return item.column_values.find((c) => c.id === id) ?? { text: null, value: null };
}

/** Monday timeline value is JSON {"from":"2026-08-20","to":"2026-08-27"}. */
function timeline(item: MondayItem): { from: string | null; to: string | null } {
  try {
    const v = JSON.parse(col(item, "project_timeline").value ?? "null");
    return { from: v?.from ?? null, to: v?.to ?? null };
  } catch {
    return { from: null, to: null };
  }
}

function dateCol(item: MondayItem, id: string): string | null {
  try {
    const v = JSON.parse(col(item, id).value ?? "null");
    return v?.date ?? null;
  } catch {
    return null;
  }
}

/**
 * Send one READ to Monday. Every call in this file goes through here, so
 * "this function only ever reads STG's board" is one place to check rather
 * than four.
 */
// deno-lint-ignore no-explicit-any
async function mondayRead(query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: MONDAY_API_TOKEN,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Monday API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Monday API: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function fetchBoardItems(): Promise<MondayItem[]> {
  const out: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    const query = `query ($board: [ID!], $cursor: String) {
      boards(ids: $board) {
        items_page(limit: 100, cursor: $cursor) {
          cursor
          items {
            id
            name
            group { id title }
            column_values { id text value }
            files: assets(column_ids: ["${FILES_COLUMN_ID}"]) { ${ASSET_FIELDS} }
            measure: assets(column_ids: ["${MEASURE_COLUMN_ID}"]) { ${ASSET_FIELDS} }
          }
        }
      }
    }`;
    const data = await mondayRead(query, { board: [BOARD_ID], cursor });
    const page = data?.boards?.[0]?.items_page;
    // Monday used to accept a query_params rule on the pseudo-column
    // "__grouping__" to return only the two groups we sync. On 2026-09-04 it
    // answered "Column not found: __grouping__" (ResourceNotFoundException),
    // so the board is walked whole — ~150 jobs, two pages — and the group
    // filter lives here instead. Same rows in, same rows out.
    out.push(...(page?.items ?? []).filter((item: MondayItem) => GROUP_IDS.includes(item.group?.id)));
    cursor = page?.cursor ?? null;
  } while (cursor);
  return out;
}

/**
 * The files on named items, whatever group they are in.
 *
 * A job the office built months ago has usually moved on to "Working on it" or
 * "Completed", so the board walk above no longer returns it — and the office
 * still adds files to it, which is exactly when "new on Monday" matters most.
 * One extra read per sync, only for rows that are actually linked to a job and
 * were not already seen, asked in pages of 100 (Monday's own item cap).
 *
 * `board { id }` is asked for because this is also the read the PULL leans on,
 * and `items(ids:)` reaches across STG's whole account. The pull refuses any
 * item whose board is not the Ops Gantt Chart; the sync ignores the field
 * because it only ever passes ids it read off that board a moment earlier.
 */
async function fetchItemsByIds(ids: string[]): Promise<MondayItem[]> {
  const out: MondayItem[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const query = `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        name
        board { id }
        files: assets(column_ids: ["${FILES_COLUMN_ID}"]) { ${ASSET_FIELDS} }
        measure: assets(column_ids: ["${MEASURE_COLUMN_ID}"]) { ${ASSET_FIELDS} }
      }
    }`;
    const data = await mondayRead(query, { ids: ids.slice(i, i + 100) });
    out.push(...((data?.items ?? []) as MondayItem[]));
  }
  return out;
}

/** PostgREST / Postgres "that column isn't there yet". */
function isMissingColumn(err: { code?: string | null } | null): boolean {
  return err?.code === "PGRST204" || err?.code === "42703";
}

/** PostgREST / Postgres "that table isn't there yet". */
function isMissingTable(err: { code?: string | null } | null): boolean {
  return err?.code === "PGRST205" || err?.code === "42P01";
}

// ---------------------------------------------------------------------------
// pull_files — bring a Monday item's files onto the job (Monday files, F4)
// ---------------------------------------------------------------------------
//
// SERVER-SIDE FOR THREE REASONS, none of them optional:
//   1. The download link Monday mints lasts an hour and is minted by a token
//      that must never reach a browser.
//   2. Only the server can check that the asset is really attached to the item
//      the office tied to this job. Without that check this endpoint would
//      happily fetch ANY asset in STG's account by id, which is somebody
//      else's paperwork.
//   3. The buckets take writes from the service role only, on purpose.
//
// NOTHING ABOUT THE CALLER COMES FROM THE REQUEST BODY. The user id comes from
// a verified JWT and the rank is read from `profiles` on the service-role key —
// the same rule manage-crew-access states at length. Assume a caller who posts
// straight at this endpoint with an installer's session; greying out a button
// is not a control.

/** 80 MB. Also the job-documents bucket's own cap — one limit, said twice. */
const MAX_PULL_BYTES = 80 * 1024 * 1024;

interface PullResult {
  asset_id: string;
  name: string;
  ok: boolean;
  where: "plans" | "specs" | "documents" | null;
  /** This exact Monday file was already on the job — a no-op, not a failure. */
  already?: boolean;
  error?: string | null;
}

/**
 * Anyone above a plain installer, exactly as the Jobs page's own `canAdd`
 * decides it (`isForemanPlus` -> `roleRank` >= 1, app/src/lib/install/types.ts).
 * The legacy names are listed because the ladder in the app lists them and a
 * server guard that disagreed with the button would be worse than no button.
 */
const CAN_ADD_A_JOB = new Set([
  "foreman",
  "lead",
  "supervisor",
  "admin",
  "owner",
  "big_boss",
]);

/**
 * A file name that is safe as the tail of a storage path.
 *
 * The same sanitiser `uploadPlanset` uses, plus two things a hand upload never
 * has to worry about: the name here comes from another company's board, so any
 * path separator is dropped before the character class runs, and leading dots
 * are replaced so a name of ".." cannot become a path segment that means
 * something.
 */
function safeStorageName(name: string): string {
  const base = (name || "file").split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 120) || "file";
}

/** "pdf" from ".PDF" or from "HC24 - LP.pdf". */
function extensionOf(name: string, ext: string | null | undefined): string {
  const raw = (ext ?? "").trim() ||
    (name.includes(".") ? name.slice(name.lastIndexOf(".")) : "");
  return raw.replace(/^\./, "").toLowerCase();
}

function plansetFormatOf(name: string, ext: string | null | undefined): string | null {
  const e = extensionOf(name, ext);
  return e === "pdf" || e === "dwg" || e === "dxf" ? e : null;
}

/** "17 MB", for a sentence a person reads. */
function mbLabel(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// The 80 MB ceiling itself is `readBodyCapped` in _shared/bytes.ts, where the
// app's own suite can exercise it against a real stream.

// deno-lint-ignore no-explicit-any
type ServiceClient = any;

/**
 * Fetch one file from Monday and put it where the office asked.
 *
 * Returns a result, never throws: one file that will not come across must not
 * stop the others, and the caller has already built the job.
 */
async function pullOneFile(
  db: ServiceClient,
  projectId: string,
  userId: string | null,
  asset: { id: string; name: string; file_extension: string | null; file_size: number | null; public_url: string },
  kind: "building" | "specs" | "document",
): Promise<PullResult> {
  const name = asset.name || `monday-${asset.id}`;
  const base: PullResult = { asset_id: asset.id, name, ok: false, where: null };
  const asPlanset = kind === "building" || kind === "specs";
  const where = kind === "building" ? "plans" : kind === "specs" ? "specs" : "documents";

  // Already here? The unique index below is the real guarantee; this is the
  // cheap read that turns a second press of Get into a sentence rather than a
  // wasted download of a 17 MB plan set.
  const table = asPlanset ? "project_plansets" : "project_documents";
  const { data: existing, error: existingErr } = await db
    .from(table)
    .select("id")
    .eq("project_id", projectId)
    .eq("source_asset_id", asset.id)
    .maybeSingle();
  if (existingErr && isMissingTable(existingErr)) {
    return { ...base, error: "Job documents aren't switched on yet. They arrive with the next update." };
  }
  if (existingErr && isMissingColumn(existingErr)) {
    return { ...base, error: "Getting files from Monday needs the next database update." };
  }
  if (existing) return { ...base, ok: true, where, already: true };

  // The picker locks this on screen and pullRequestFiles locks it again on the
  // way out of the browser; this is the third lock, and the only one a caller
  // posting straight at this endpoint has to get past. A planset row whose
  // source_format lied would be a file the extractor opens and the map draws.
  const format = plansetFormatOf(name, asset.file_extension);
  if (asPlanset && !format) {
    return { ...base, error: "Only a PDF, DWG or DXF can be plans or specs." };
  }

  // THREE CHECKS, AND ONLY THE LAST ONE IS A LIMIT.
  //
  // Monday's `file_size` is metadata, and it is `number | null` — so this first
  // check is a courtesy that saves a pointless 80 MB download when Monday
  // happens to have said. It used to be the ONLY check before the body was
  // read, which meant a file Monday said nothing about had no ceiling at all:
  // `res.arrayBuffer()` buffered whatever arrived and the size was measured
  // afterwards, in an edge runtime, with the whole thing already resident.
  const tooBig = `Anything over ${mbLabel(MAX_PULL_BYTES)} has to be added by hand.`;
  const stated = typeof asset.file_size === "number" ? asset.file_size : null;
  if (stated !== null && stated > MAX_PULL_BYTES) {
    return { ...base, error: `This file is ${mbLabel(stated)}. ${tooBig}` };
  }

  let bytes: Uint8Array;
  let contentType: string;
  try {
    const res = await fetch(asset.public_url);
    if (!res.ok) {
      return { ...base, error: `Monday would not hand this file over (${res.status}). Try again in a minute.` };
    }
    contentType = res.headers.get("content-type") ?? "application/octet-stream";

    // What the response itself says, which beats what Monday's metadata said:
    // refuse before a single byte of the body is read.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_PULL_BYTES) {
      await res.body?.cancel();
      return { ...base, error: `This file is ${mbLabel(declared)}. ${tooBig}` };
    }

    // And the real ceiling, for the responses that declare nothing at all.
    const read = await readBodyCapped(res, MAX_PULL_BYTES);
    if (read === null) {
      return { ...base, error: `This file is bigger than ${mbLabel(MAX_PULL_BYTES)}. ${tooBig}` };
    }
    bytes = read;
  } catch (err) {
    // THE MESSAGE STAYS ON THE SERVER. Deno puts the request URL into the
    // message of any network failure ("error sending request for url (…)"),
    // and the URL here is Monday's one-hour unauthenticated download link —
    // the one thing this whole design refuses to store or show, because a
    // person who sees it has another company's document without signing in to
    // anything. The log is where an engineer reads it.
    console.error(
      "monday-sync: download failed for asset",
      asset.id,
      err instanceof Error ? err.name : "unknown error",
    );
    return { ...base, error: "Could not download this file from Monday. Try again in a minute." };
  }

  const bucket = asPlanset ? "plansets" : "job-documents";
  const path = `${projectId}/${Date.now()}-${safeStorageName(name)}`;
  const { error: upErr } = await db.storage
    .from(bucket)
    .upload(path, bytes, { contentType });
  if (upErr) {
    // Storage's own text names buckets and policies. The repo's rule is that
    // an error tells a person what to do, not what the database returned.
    console.error("monday-sync: could not store", path, upErr.message);
    return { ...base, error: "Could not save this file. Try again in a minute." };
  }

  // Exactly what uploadPlanset writes for a hand upload, so the Plans page,
  // the map and the extractor cannot tell the two apart: PDFs are 'uploaded'
  // and ready to be read, CAD files are 'converting' because nothing converts
  // them yet.
  const row = asPlanset
    ? {
      project_id: projectId,
      storage_path: path,
      source_format: format,
      status: format === "pdf" ? "uploaded" : "converting",
      kind,
      source_asset_id: asset.id,
    }
    : {
      project_id: projectId,
      name,
      storage_path: path,
      size_bytes: bytes.byteLength,
      content_type: contentType,
      source: "monday",
      source_asset_id: asset.id,
      // THE MONEY WALL, decided here because here is the only place that knows
      // the file's real name. A signed quote and the ironwork order arrive in
      // the same Monday column; wave Z settled that the company's own numbers
      // answer to `can_see_costs` and not to a rank, and the table's policy
      // reads this flag. Wrong towards office-only on purpose — see the
      // migration's section 3b.
      money: looksLikeMoneyDocument(name),
      created_by: userId,
    };

  const { error: insErr } = await db.from(table).insert(row);
  if (insErr) {
    // Two callers pressing Get at the same moment: the unique index refuses the
    // second one, which is the answer we wanted, not an error.
    if (insErr.code === "23505") {
      await db.storage.from(bucket).remove([path]);
      return { ...base, ok: true, where, already: true };
    }
    // Anything else leaves bytes in a bucket with nothing pointing at them.
    await db.storage.from(bucket).remove([path]);
    if (isMissingTable(insErr) || isMissingColumn(insErr)) {
      return { ...base, error: "Getting files from Monday needs the next database update." };
    }
    // Postgres names constraints in its messages; an installer reading
    // "project_documents_project_id_fkey" learns nothing and we have leaked
    // the shape of the schema to do it.
    console.error("monday-sync: could not file", asset.id, insErr.code, insErr.message);
    return { ...base, error: "Could not add this file to the job. Try again in a minute." };
  }

  return { ...base, ok: true, where };
}

async function handlePullFiles(
  req: Request,
  db: ServiceClient,
  // deno-lint-ignore no-explicit-any
  body: any,
): Promise<Response> {
  const auth = await verifyCaller(req);
  if (auth.status === "unauthorized") {
    return jsonResponse({ ok: false, error: "You need to be signed in to do that." }, 401);
  }
  if (auth.status === "unconfigured") {
    // Without the anon key this function cannot tell who is asking, and this
    // endpoint writes to a job. Refusing is the only honest answer.
    return jsonResponse(
      { ok: false, error: "We could not check who you are. Try again in a minute." },
      503,
    );
  }

  const userId = auth.user.role === "service_role" ? null : auth.user.id;
  if (userId) {
    const { data: profile } = await db
      .from("profiles")
      .select("role, is_partner, is_test")
      .eq("id", userId)
      .maybeSingle();
    const role = (profile?.role as string | undefined) ?? "";
    if (profile?.is_partner === true || !CAN_ADD_A_JOB.has(role)) {
      return jsonResponse(
        { ok: false, error: "Only a foreman or above can bring files in from Monday." },
        403,
      );
    }
    // The test-login fence, restated here because this function writes on the
    // service-role key and so runs past the trigger that enforces it
    // (20260730220000). A test login may only touch its sandbox job.
    if (profile?.is_test === true) {
      const { data: sandbox } = await db
        .from("sandbox_projects")
        .select("project_id")
        .eq("project_id", String(body?.project_id ?? ""))
        .maybeSingle();
      if (!sandbox) {
        return jsonResponse(
          { ok: false, error: "This is a test login. It can only work on the test job." },
          403,
        );
      }
    }
  }

  const mondayJobId = String(body?.monday_job_id ?? "").trim();
  const projectId = String(body?.project_id ?? "").trim();
  const asked = Array.isArray(body?.files) ? body.files : [];
  if (!mondayJobId || !projectId) {
    return jsonResponse(
      { ok: false, error: "We need to know which Monday job and which app job." },
      400,
    );
  }
  if (asked.length === 0) return jsonResponse({ ok: true, results: [] });

  const { data: staged, error: stagedErr } = await db
    .from("monday_jobs")
    .select("id, project_id, monday_item_id")
    .eq("id", mondayJobId)
    .maybeSingle();
  if (stagedErr && (isMissingTable(stagedErr) || isMissingColumn(stagedErr))) {
    return jsonResponse(
      { ok: false, error: "Getting files from Monday needs the next database update." },
      503,
    );
  }
  if (!staged) {
    return jsonResponse({ ok: false, error: "That Monday job is not in the app." }, 404);
  }
  // THE OFFICE TIED THIS ROW TO THIS JOB, and nobody else gets to say
  // otherwise. Without this a caller could name any project id and have another
  // job's paperwork filed against it.
  if (staged.project_id !== projectId) {
    return jsonResponse(
      { ok: false, error: "That Monday job is linked to a different job in the app." },
      403,
    );
  }

  // WHAT MONDAY SAYS RIGHT NOW — asked again, here, at the moment of the pull.
  //
  // This used to read `monday_jobs.files`, and that was wrong. That column is a
  // MIRROR of somebody else's board, and the table's "lead update" policy
  // (20260812000000) lets any foreman rewrite the whole row from the browser.
  // An allow-list the caller can write is not an allow-list: three lines in a
  // console would have put any asset id into that column, and this function
  // would then have fetched it. `assets(ids:)` below is account-wide and
  // Monday's asset ids are sequential integers, so the reachable set was every
  // document in STG's account.
  //
  // Two things make it an allow-list again: the file list comes from Monday
  // rather than from us, and Monday has to agree the item is on THIS board —
  // `items(ids:)` reaches across the whole account, so without the board check
  // a made-up item id would be an equally good way in.
  const mondayItemId = String(staged.monday_item_id ?? "").trim();
  if (!mondayItemId) {
    return jsonResponse(
      { ok: false, error: "That job is not linked to a Monday item any more." },
      404,
    );
  }
  let item: MondayItem | null = null;
  try {
    const [found] = await fetchItemsByIds([mondayItemId]);
    item = found ?? null;
  } catch (err) {
    console.error(
      "monday-sync: could not re-read the item before a pull:",
      err instanceof Error ? err.message : String(err),
    );
    return jsonResponse(
      {
        ok: false,
        error: "We could not check with Monday which files are on this job. Try again in a minute.",
      },
      503,
    );
  }
  const allowed = pullAllowList(item, BOARD_ID);
  if (!allowed.ok) {
    return allowed.reason === "gone"
      ? jsonResponse({ ok: false, error: "Monday no longer has this job." }, 404)
      : jsonResponse(
        { ok: false, error: "That Monday job is not on the board this app reads." },
        403,
      );
  }
  const onTheRow = new Map<string, StagedFile>();
  for (const f of allowed.files) onTheRow.set(f.asset_id, f);

  const results: PullResult[] = [];
  const chosen: { asset_id: string; kind: "building" | "specs" | "document" }[] = [];
  for (const raw of asked) {
    const assetId = String(raw?.asset_id ?? "");
    const known = onTheRow.get(assetId);
    if (!known) {
      results.push({
        asset_id: assetId,
        name: "",
        ok: false,
        where: null,
        error: "That file is not on this Monday job any more. Sync and try again.",
      });
      continue;
    }
    const kind = raw?.kind === "building" || raw?.kind === "specs" ? raw.kind : "document";
    chosen.push({ asset_id: assetId, kind });
  }

  if (chosen.length > 0) {
    // Fresh links, asked for at the moment of the pull. Monday's public_url is
    // good for an hour, which is why it is never stored.
    let assets: Record<string, {
      id: string;
      name: string;
      file_extension: string | null;
      file_size: number | null;
      public_url: string;
    }> = {};
    try {
      const query = `query ($ids: [ID!]!) {
        assets(ids: $ids) { id name file_extension file_size public_url }
      }`;
      const data = await mondayRead(query, { ids: chosen.map((c) => c.asset_id) });
      for (const a of data?.assets ?? []) assets[String(a.id)] = a;
    } catch (err) {
      console.error(
        "monday-sync: Monday refused the file links:",
        err instanceof Error ? err.message : String(err),
      );
      assets = {};
      for (const c of chosen) {
        results.push({
          asset_id: c.asset_id,
          name: onTheRow.get(c.asset_id)?.name ?? "",
          ok: false,
          where: null,
          error: "Monday would not hand the files over. Try again in a minute.",
        });
      }
    }

    for (const c of chosen) {
      const fresh = assets[c.asset_id];
      if (!fresh) continue; // already reported above, or gone from Monday
      results.push(
        await pullOneFile(
          db,
          projectId,
          userId,
          { ...fresh, name: fresh.name || onTheRow.get(c.asset_id)?.name || "" },
          c.kind,
        ),
      );
    }

    // An id Monday no longer knows at all.
    for (const c of chosen) {
      if (assets[c.asset_id] || results.some((r) => r.asset_id === c.asset_id)) continue;
      results.push({
        asset_id: c.asset_id,
        name: onTheRow.get(c.asset_id)?.name ?? "",
        ok: false,
        where: null,
        error: "Monday no longer has this file.",
      });
    }
  }

  // `ok` says the request was handled, not that every file came across — each
  // file carries its own answer, and "2 of 3" is a sentence the Build form
  // knows how to say.
  return jsonResponse({ ok: true, results });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Feature-detect the token (the guard form scripts/function_secrets.py
  // reads as OPTIONAL): until the owner sets MONDAY_API_TOKEN this function
  // reports itself unconfigured instead of failing the deploy secret gate —
  // same pattern as ask's optional OPENAI key.
  if (Deno.env.get("MONDAY_API_TOKEN")) {
    // configured — continue below
  } else {
    return jsonResponse({ ok: false, error: "MONDAY_API_TOKEN is not configured" }, 500);
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  // deno-lint-ignore no-explicit-any
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    // No body — normal throttled sync.
  }

  // The office bringing a Monday item's files onto a job it has just built.
  // Everything below this line is the ordinary board sync and is untouched.
  if (body?.action === "pull_files") {
    try {
      return await handlePullFiles(req, db, body);
    } catch (err) {
      // The reason is logged, never returned: everything that can reach here
      // has either Monday's one-hour download link or raw Postgres text in its
      // message, and this response goes straight onto an office screen.
      console.error(
        "monday-sync: pull_files failed:",
        err instanceof Error ? err.message : String(err),
      );
      return jsonResponse(
        { ok: false, error: "Could not get the files. Try again in a minute.", results: [] },
        500,
      );
    }
  }

  const force = Boolean(body?.force);

  // Throttle: one real sync per window, whoever asks.
  if (!force) {
    const { data: last } = await db
      .from("monday_jobs")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last && Date.now() - new Date(last.synced_at).getTime() < THROTTLE_MS) {
      return jsonResponse({ ok: true, skipped: "fresh" });
    }
  }

  // Monday's own refusal (a bad or expired token, a board this token cannot
  // see, a retired API version) used to escape as a bare "Internal Server
  // Error", and supabase-js drops the body of any non-2xx — so the office saw
  // "Sync failed." and nothing else. Answer 200 with ok:false and the reason,
  // the shape the Jobs page already renders.
  let items: MondayItem[];
  try {
    items = await fetchBoardItems();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("monday-sync: Monday refused the sync:", reason);
    return jsonResponse({ ok: false, error: `Monday refused the sync — ${reason}` });
  }
  const now = new Date().toISOString();

  const rows = items.map((item) => {
    const tl = timeline(item);
    const budgetText = col(item, "numbers").text;
    return {
      monday_item_id: item.id,
      board_id: BOARD_ID,
      name: item.name,
      group_title: item.group.title,
      status: col(item, "project_status").text,
      job_type: col(item, "color_mm4wezrj").text,
      start_date: tl.from ?? dateCol(item, "date_mkn9fxb6"),
      end_date: tl.to,
      est_arrival: dateCol(item, "date_mks04a5j"),
      budget: budgetText ? Number(budgetText) || null : null,
      flashing_note: col(item, "text_mknb4sbz").text,
      raw: { column_values: item.column_values },
      files: filesOf(item),
      synced_at: now,
      left_groups_at: null,
    };
  });

  if (rows.length > 0) {
    const { error } = await db
      .from("monday_jobs")
      .upsert(rows, { onConflict: "monday_item_id" });
    // A deploy that lands this function before its migration would otherwise
    // stop the sync dead over a column nobody is reading yet. Drop the file
    // list and save everything else — the Jobs page keeps working and the next
    // sync after the migration fills the files in.
    if (error && isMissingColumn(error)) {
      const { error: retry } = await db
        .from("monday_jobs")
        .upsert(rows.map(({ files: _files, ...rest }) => rest), {
          onConflict: "monday_item_id",
        });
      if (retry) return jsonResponse({ ok: false, error: retry.message }, 500);
    } else if (error) {
      return jsonResponse({ ok: false, error: error.message }, 500);
    }
  }

  // Rows that vanished from the synced groups: mark them so the incoming
  // list stops showing jobs Monday moved on or canceled.
  const seen = new Set(rows.map((r) => r.monday_item_id));
  const { data: existing } = await db
    .from("monday_jobs")
    .select("monday_item_id")
    .is("left_groups_at", null);
  const gone = (existing ?? [])
    .map((r) => r.monday_item_id as string)
    .filter((id) => !seen.has(id));
  if (gone.length > 0) {
    await db
      .from("monday_jobs")
      .update({ left_groups_at: now })
      .in("monday_item_id", gone);
  }

  // Linked projects follow Monday's dates until install work starts —
  // then the app owns the job and Monday stops steering it.
  const { data: linked } = await db
    .from("monday_jobs")
    .select("monday_item_id, project_id, start_date, end_date")
    .not("project_id", "is", null);

  // Files on a job the board walk no longer returns. Best-effort on purpose:
  // this is an extra courtesy on top of a sync that has already succeeded, so a
  // Monday hiccup here logs and moves on rather than turning a good sync red.
  let refreshedFiles = 0;
  const staleIds = (linked ?? [])
    .map((l) => l.monday_item_id as string)
    .filter((id) => !seen.has(id));
  if (staleIds.length > 0) {
    try {
      for (const item of await fetchItemsByIds(staleIds)) {
        const { error } = await db
          .from("monday_jobs")
          .update({ files: filesOf(item) })
          .eq("monday_item_id", item.id);
        if (!error) refreshedFiles += 1;
        else if (isMissingColumn(error)) break; // migration not deployed yet
      }
    } catch (err) {
      console.error(
        "monday-sync: could not refresh files on already-built jobs:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  // Wave D: this whole function writes on the service-role key, which
  // bypasses the RLS that would otherwise refuse an UPDATE on a trashed
  // project row — so Monday must never quietly keep steering the dates of a
  // job the company just deleted. Fetched once, not per row.
  const { data: trashedRows } = await db
    .from("projects")
    .select("id")
    .not("deleted_at", "is", null);
  const trashedIds = new Set((trashedRows ?? []).map((r) => r.id as string));
  let updatedProjects = 0;
  for (const l of linked ?? []) {
    const fresh = rows.find((r) => r.monday_item_id === l.monday_item_id);
    if (!fresh || !fresh.start_date) continue;
    if (trashedIds.has(l.project_id as string)) continue; // deleted — Monday stops steering it
    const { data: started } = await db
      .from("project_openings")
      .select("id")
      .eq("project_id", l.project_id)
      .not("work_started_at", "is", null)
      .limit(1);
    if ((started ?? []).length > 0) continue; // crew is on the wall — app owns it
    const { error } = await db
      .from("projects")
      .update({ start_date: fresh.start_date, end_date: fresh.end_date })
      .eq("id", l.project_id);
    if (!error) updatedProjects += 1;
  }

  return jsonResponse({
    ok: true,
    synced: rows.length,
    leftGroups: gone.length,
    updatedProjects,
    refreshedFiles,
  });
});

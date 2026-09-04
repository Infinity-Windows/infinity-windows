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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_API_TOKEN = Deno.env.get("MONDAY_API_TOKEN") ?? "";

const BOARD_ID = "8185408239"; // Ops Gantt Chart ("STG Windows" workspace)
const GROUP_IDS = ["group_mkwrzygn", "group_mkwrz2sm"]; // Ready to Schedule, Scheduled
const THROTTLE_MS = 10 * 60 * 1000;

// The board's two file columns, verified against the live board on 2026-09-04:
// "Files" (files_1) is where the office puts a job's paperwork and carries 1-4
// PDFs on every sampled row; "Measure files" (file_mm4wnjn8) is empty today but
// is the column a site survey would land in, so it is read from the start
// rather than discovered missing later. Asked for one column at a time under a
// GraphQL alias, because asking for both column ids at once returns one flat
// list that does not say which column each file came from.
const FILES_COLUMN_ID = "files_1";
const MEASURE_COLUMN_ID = "file_mm4wnjn8";

interface MondayAsset {
  id: string;
  name: string;
  file_extension: string | null;
  file_size: number | null;
  created_at: string | null;
}

interface MondayItem {
  id: string;
  name: string;
  group: { id: string; title: string };
  column_values: { id: string; text: string | null; value: string | null }[];
  /** Aliased `assets(column_ids: ["files_1"])`. */
  files?: MondayAsset[] | null;
  /** Aliased `assets(column_ids: ["file_mm4wnjn8"])`. */
  measure?: MondayAsset[] | null;
}

/** One entry in monday_jobs.files — see the migration for why no public_url. */
interface StagedFile {
  asset_id: string;
  name: string;
  ext: string | null;
  size: number | null;
  column_id: string;
  uploaded_at: string | null;
}

/** Everything Monday says is attached to an item, in board order per column. */
function filesOf(item: MondayItem): StagedFile[] {
  const out: StagedFile[] = [];
  const take = (assets: MondayAsset[] | null | undefined, columnId: string) => {
    for (const a of assets ?? []) {
      if (!a?.id) continue;
      out.push({
        asset_id: String(a.id),
        name: a.name ?? "",
        ext: a.file_extension ?? null,
        size: typeof a.file_size === "number" ? a.file_size : null,
        column_id: columnId,
        uploaded_at: a.created_at ?? null,
      });
    }
  };
  take(item.files, FILES_COLUMN_ID);
  take(item.measure, MEASURE_COLUMN_ID);
  return out;
}

/** The asset fields both reads ask for. Never public_url — see the migration. */
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
 */
async function fetchItemsByIds(ids: string[]): Promise<MondayItem[]> {
  const out: MondayItem[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const query = `query ($ids: [ID!]) {
      items(ids: $ids) {
        id
        name
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
  let force = false;
  try {
    const body = await req.json();
    force = Boolean(body?.force);
  } catch {
    // No body — normal throttled sync.
  }

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

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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders, jsonResponse } from "../_shared/openai.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MONDAY_API_TOKEN = Deno.env.get("MONDAY_API_TOKEN") ?? "";

const BOARD_ID = "8185408239"; // Ops Gantt Chart ("STG Windows" workspace)
const GROUP_IDS = ["group_mkwrzygn", "group_mkwrz2sm"]; // Ready to Schedule, Scheduled
const THROTTLE_MS = 10 * 60 * 1000;

interface MondayItem {
  id: string;
  name: string;
  group: { id: string; title: string };
  column_values: { id: string; text: string | null; value: string | null }[];
}

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

async function fetchBoardItems(): Promise<MondayItem[]> {
  const out: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    const query = `query ($board: [ID!], $cursor: String) {
      boards(ids: $board) {
        items_page(limit: 100, cursor: $cursor,
          query_params: { rules: [{ column_id: "__grouping__", compare_value: ${JSON.stringify(GROUP_IDS)}, operator: any_of }] }
        ) {
          cursor
          items {
            id
            name
            group { id title }
            column_values { id text value }
          }
        }
      }
    }`;
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: MONDAY_API_TOKEN,
        "API-Version": "2024-10",
      },
      body: JSON.stringify({ query, variables: { board: [BOARD_ID], cursor } }),
    });
    if (!res.ok) throw new Error(`Monday API ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`Monday API: ${JSON.stringify(json.errors)}`);
    const page = json.data?.boards?.[0]?.items_page;
    out.push(...(page?.items ?? []));
    cursor = page?.cursor ?? null;
  } while (cursor);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!MONDAY_API_TOKEN) {
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

  const items = await fetchBoardItems();
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
      synced_at: now,
      left_groups_at: null,
    };
  });

  if (rows.length > 0) {
    const { error } = await db
      .from("monday_jobs")
      .upsert(rows, { onConflict: "monday_item_id" });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
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
  let updatedProjects = 0;
  for (const l of linked ?? []) {
    const fresh = rows.find((r) => r.monday_item_id === l.monday_item_id);
    if (!fresh || !fresh.start_date) continue;
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
  });
});

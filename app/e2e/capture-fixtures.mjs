// Re-capture the job-map fixtures from production, read-only.
//
// The screenshot harness must not need a login or a token, so the map's data is
// committed as JSON under e2e/fixtures/ and replayed by page.route(). This
// script is how those files were produced, and how to refresh them when the
// real jobs change. It reads through the Supabase management API with a
// personal token and writes nothing back.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... node e2e/capture-fixtures.mjs
//
// The shapes match what the app actually asks PostgREST for: `OPENING_SELECT`
// (openings plus their type, assigned unit, project and assignee), `PROFILE_COLS`
// (never the PIN hash), and `select("*")` for the rest.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_REF = "czprjcskmzzagdztqonm";
const JOB_CODES = ["BLACK22", "PECAN14", "OAKRIDGE"];
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error("SUPABASE_ACCESS_TOKEN is required (read-only management token).");
  process.exit(1);
}

const jobList = JOB_CODES.map((code) => `'${code}'`).join(", ");

async function query(sql) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/** One row, one JSON document — `select json_agg(...)` style queries. */
async function queryJson(sql) {
  const rows = await query(sql);
  return rows[0]?.doc ?? [];
}

async function write(name, value) {
  const file = join(OUT_DIR, name);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  const count = Array.isArray(value) ? value.length : 1;
  console.log(`${name}  (${count} row${count === 1 ? "" : "s"})`);
}

await mkdir(OUT_DIR, { recursive: true });

const projects = await queryJson(`
  select json_agg(p order by p.name) as doc
  from projects p
  where p.job_code in (${jobList})
`);
await write("projects.json", projects);

const plansets = await queryJson(`
  select json_agg(ps order by ps.created_at desc) as doc
  from project_plansets ps
  join projects p on p.id = ps.project_id
  where p.job_code in (${jobList})
`);
await write("plansets.json", plansets);

// OPENING_SELECT: "*, window_types(*), windows:assigned_window_id(*),
// projects(*), assignee:assigned_to(id, display_name, skill_level, role, active)"
for (const project of projects) {
  const openings = await queryJson(`
    select json_agg(row order by row.opening_code) as doc
    from (
      select
        o.*,
        to_jsonb(wt) - 'embedding' as window_types,
        to_jsonb(w) as windows,
        to_jsonb(p) as projects,
        case when pr.id is null then null else json_build_object(
          'id', pr.id,
          'display_name', pr.display_name,
          'skill_level', pr.skill_level,
          'role', pr.role,
          'active', pr.active
        ) end as assignee
      from project_openings o
      join projects p on p.id = o.project_id
      left join window_types wt on wt.id = o.window_type_id
      left join windows w on w.id = o.assigned_window_id
      left join profiles pr on pr.id = o.assigned_to
      where o.project_id = '${project.id}'
    ) row
  `);
  await write(`openings.${project.job_code}.json`, openings);
}

// Every window type any of these openings points at (the map reads type_code).
const windowTypes = await queryJson(`
  select json_agg(to_jsonb(wt) - 'embedding' order by wt.type_code) as doc
  from window_types wt
  where wt.id in (
    select o.window_type_id from project_openings o
    join projects p on p.id = o.project_id
    where p.job_code in (${jobList}) and o.window_type_id is not null
  )
`);
await write("window_types.json", windowTypes);

// PROFILE_COLS only — the PIN hash must never reach a fixture.
const profiles = await queryJson(`
  select json_agg(json_build_object(
    'id', pr.id,
    'display_name', pr.display_name,
    'skill_level', pr.skill_level,
    'role', pr.role,
    'active', pr.active,
    'created_at', pr.created_at,
    'updated_at', pr.updated_at
  ) order by pr.role desc, pr.display_name) as doc
  from profiles pr
  where pr.active
`);
await write("profiles.json", profiles);

const markSpecs = await queryJson(`
  select json_agg(ms order by ms.mark_code) as doc
  from project_mark_specs ms
  join projects p on p.id = ms.project_id
  where p.job_code in (${jobList})
`);
await write("mark_specs.json", markSpecs);

const elevationViews = await queryJson(`
  select json_agg(ev order by ev.mark_code) as doc
  from project_mark_elevation_views ev
  join projects p on p.id = ev.project_id
  where p.job_code in (${jobList})
`);
await write("elevation_views.json", elevationViews);

// The interesting part of these three jobs: nobody has traced a footprint, so
// the drawing has to come from the marks. Captured so the fixture states that
// as a fact rather than assuming it.
const outlines = await queryJson(`
  select json_agg(po) as doc
  from project_plan_outlines po
  join projects p on p.id = po.project_id
  where p.job_code in (${jobList})
`);
await write("plan_outlines.json", outlines);

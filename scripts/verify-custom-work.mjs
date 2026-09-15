// Disposable SQL checks. No network or production database connection.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(
  process.env.PGLITE_MODULE ?? "@electric-sql/pglite"
);
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon;
create table profiles(id uuid primary key,role text,active boolean default true,partner boolean default false);
create table projects(id uuid primary key,deleted_at timestamptz);
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'planned',removed_at timestamptz);
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz);
create table opening_phases(started_by uuid,status text,paused_at timestamptz);
create function is_partner_user() returns boolean language sql security definer as $$select coalesce((select partner from profiles where id=auth.uid()),false)$$;
create function _is_lead(p uuid) returns boolean language sql as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function is_test_profile(p uuid) returns boolean language sql as $$select false$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$update unit_sessions set ended_at=now(),end_reason=r where profile_id=p and ended_at is null$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
grant select on profiles,projects to authenticated;
`);
await db.exec(
  await readFile(
    new URL(
      "../supabase/migrations/20261011000000_custom_work.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
await db.exec(
  "create trigger unit_sessions_follow_shift after update on time_shifts for each row execute function unit_sessions_follow_shift()",
);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await db.query(
  `insert into profiles values ($1,'owner',true,false),($2,'installer',true,false),($3,'installer',true,false),($4,'owner',true,true),($5,'installer',false,false)`,
  [1, 2, 3, 4, 5].map(id),
);
await db.query("insert into projects values ($1,null),($2,null)", [
  id(10),
  id(11),
]);
await db.query(
  "insert into project_openings(id,project_id) values ($1,$2),($3,$4)",
  [id(20), id(10), id(21), id(11)],
);
await db.exec(
  `insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,break_started_at,status) values ('${id(30)}','${id(2)}','${id(10)}',now()-interval '2 hours',null,null,'open'),('${id(31)}','${id(3)}','${id(10)}',now()-interval '2 hours',null,null,'open'); insert into toolbox_completions values ('${id(2)}',now()),('${id(3)}',now());`,
);
let n = 100,
  checks = 0;
async function asUser(i) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    id(i),
  ]);
  await db.exec("set role authenticated");
}
async function command(action, data, key = id(n++)) {
  return (
    await db.query("select custom_work_command($1,$2,$3) id", [
      key,
      action,
      data,
    ])
  ).rows[0].id;
}
async function denied(fn) {
  await assert.rejects(fn);
  checks++;
}
const t = (offset) => new Date(Date.now() + offset * 60000).toISOString();
const unit = {
  id: id(40),
  revision: 0,
  project_id: id(10),
  opening_id: null,
  label: "16",
  type_label: "Custom pivot",
  facts: {},
};
await asUser(2);
assert.equal(await command("unit", unit, id(1000)), id(40));
checks++;
assert.equal(await command("unit", unit, id(1000)), id(40));
checks++;
await denied(() =>
  command("unit", { ...unit, label: "Different retry" }, id(1000)),
);
await denied(() => command("unit", unit));
await denied(() =>
  command("unit", { ...unit, id: id(41), opening_id: id(21) }),
);
for (const facts of [
  { width_in: -1 },
  { height_in: "30" },
  { unsupported: "x" },
  null,
])
  await denied(() => command("unit", { ...unit, id: id(41), facts }));
await denied(() =>
  command("type", { id: id(50), revision: 0, label: "Secret type" }),
);
await denied(() => db.exec(`update custom_work_units set label='forged'`));
await denied(() =>
  db.exec(
    `insert into custom_work_commands(id,profile_id,payload) values('${id(2000)}','${id(2)}','{}')`,
  ),
);
const start = {
  id: id(60),
  unit_id: id(40),
  shift_id: id(30),
  expected_session_id: null,
  at: t(-60),
  stage: "Installing",
};
await command("start", start);
checks++;
await denied(() => command("start", { ...start, id: id(61) }));
await denied(() =>
  command("stop", { expected_session_id: id(60), at: t(-70) }),
);
await command("start", {
  ...start,
  id: id(61),
  unit_id: null,
  expected_session_id: id(60),
  at: t(-40),
  description: "Moving material",
});
checks++;
let rows = (
  await db.query("select * from custom_work_sessions order by started_at")
).rows;
assert.equal(String(rows[0].ended_at), String(rows[1].started_at));
checks++;
await asUser(3);
await denied(() =>
  command("unit", { ...unit, revision: 1, label: "Edit somebody else" }),
);
await denied(() =>
  command("session", {
    id: id(60),
    revision: 2,
    reason: "Change other time",
    description: "Fake",
  }),
);
await command("start", {
  ...start,
  id: id(62),
  shift_id: id(31),
  at: t(-30),
  participation: "helper",
});
checks++;
await command("stop", {
  expected_session_id: id(62),
  at: t(-10),
  outcome: "partial",
  finish_note: "Helped lift",
});
checks++;
await asUser(2);
await command("stop", {
  expected_session_id: id(61),
  at: t(-20),
  finish_note: "Supplies gathered",
});
checks++;
await command("unit", {
  ...unit,
  id: id(41),
  project_id: null,
  label: "Unassigned",
});
checks++;
await asUser(3);
assert.equal(
  (await db.query(`select * from custom_work_units where id='${id(41)}'`)).rows
    .length,
  0,
);
checks++;
await denied(() =>
  command("start", {
    ...start,
    id: id(63),
    shift_id: id(31),
    unit_id: id(41),
    at: t(-5),
  }),
);
await asUser(2);
await command("unit", {
  ...unit,
  id: id(41),
  revision: 1,
  reason: "Assign field record",
});
checks++;
await command("link", {
  ...unit,
  revision: 1,
  opening_id: id(20),
  reason: "Map match",
});
checks++;
await denied(() =>
  command("unit", { ...unit, id: id(42), opening_id: id(20) }),
);
await command("start", { ...start, id: id(64), at: t(-5) });
checks++;
await db.exec(
  `reset role; insert into unit_sessions(id,profile_id,opening_id,started_at,ended_at,end_reason) values('${id(70)}','${id(2)}','${id(20)}',now()-interval '4 minutes',null,null);`,
);
assert.equal(
  (
    await db.query(
      `select end_reason from custom_work_sessions where id='${id(64)}'`,
    )
  ).rows[0].end_reason,
  "legacy_unit",
);
checks++;
await asUser(2);
await command("start", { ...start, id: id(65), at: t(-3) });
checks++;
await db.exec(
  `reset role; update time_shifts set break_started_at=now()-interval '2 minutes' where id='${id(30)}'`,
);
assert.equal(
  (
    await db.query(
      `select end_reason from custom_work_sessions where id='${id(65)}'`,
    )
  ).rows[0].end_reason,
  "break",
);
checks++;
await asUser(2);
await denied(() => command("start", { ...start, id: id(66), at: t(-1) }));
await asUser(1);
await command("type", { id: id(50), revision: 0, label: "Special storefront" });
checks++;
await command("type", {
  id: id(50),
  revision: 1,
  label: "Special storefront",
  archived: true,
});
checks++;
await denied(() =>
  command("type", { id: id(50), revision: 1, label: "Stale rename" }),
);
await asUser(3);
await command("start", { ...start, id: id(75), shift_id: id(31), at: t(-9) });
checks++;
await db.exec(
  `reset role; insert into task_sessions values('${id(80)}','${id(3)}','${id(20)}',now()-interval '8 minutes',null)`,
);
assert.equal(
  (
    await db.query(
      `select end_reason from custom_work_sessions where id='${id(75)}'`,
    )
  ).rows[0].end_reason,
  "legacy_unit",
);
checks++;
await asUser(3);
await command("start", { ...start, id: id(76), shift_id: id(31), at: t(-7) });
checks++;
await db.exec("reset role");
assert.ok(
  (await db.query(`select ended_at from task_sessions where id='${id(80)}'`))
    .rows[0].ended_at,
);
checks++;
await db.exec(
  `reset role; insert into opening_phases values('${id(3)}','active',null)`,
);
assert.equal(
  (
    await db.query(
      `select end_reason from custom_work_sessions where id='${id(76)}'`,
    )
  ).rows[0].end_reason,
  "legacy_phase",
);
checks++;
for (const user of [4, 5]) {
  await asUser(user);
  for (const table of [
    "custom_work_units",
    "custom_work_sessions",
    "custom_work_types",
    "custom_work_history",
  ]) {
    assert.equal((await db.query(`select * from ${table}`)).rows.length, 0);
    checks++;
  }
  await denied(() => command("unit", { ...unit, id: id(90) }));
}
await db.exec("reset role; set role anon");
await denied(() => command("unit", unit));

// Resume after a custom-work break cannot resurrect an unrelated legacy window.
await db.exec(
  `reset role; insert into unit_sessions(id,profile_id,opening_id,started_at,ended_at,end_reason) values('${id(71)}','${id(2)}','${id(20)}',now()-interval '100 minutes',now()-interval '90 minutes','break'); update time_shifts set break_started_at=null,break_seconds=60 where id='${id(30)}'`,
);
assert.equal(
  (
    await db.query(
      `select * from unit_sessions where profile_id='${id(2)}' and ended_at is null`,
    )
  ).rows.length,
  0,
);
checks++;
await asUser(2);
await command("start", { ...start, id: id(66), at: t(-1) });
checks++;
await db.exec(
  `reset role; update time_shifts set clock_out_at=now(),status='submitted' where id='${id(30)}'`,
);
assert.equal(
  (
    await db.query(
      `select end_reason from custom_work_sessions where id='${id(66)}'`,
    )
  ).rows[0].end_reason,
  "clock_out",
);
checks++;
await asUser(2);
await command("start", {
  ...start,
  id: id(67),
  unit_id: null,
  expected_session_id: id(66),
  at: t(-0.5),
  description: "Cleanup from offline queue",
});
checks++;
assert.equal(
  (
    await db.query(
      `select review_required from custom_work_sessions where id='${id(67)}'`,
    )
  ).rows[0].review_required,
  true,
);
checks++;
await command("stop", {
  expected_session_id: id(67),
  at: t(-0.1),
  finish_note: "Cleanup done",
});
checks++;
await denied(() => command("start", { ...start, id: id(68), at: t(1) }));
await denied(() =>
  command("unit", {
    ...unit,
    revision: 2,
    facts: { installation_complete: true },
  }),
);
assert.equal(
  (
    await db.query(
      `select legacy_time_present from custom_work_units where id='${id(40)}'`,
    )
  ).rows[0].legacy_time_present,
  true,
);
checks++;
await asUser(2);
let reviewRow = (
  await db.query(`select * from custom_work_sessions where id='${id(67)}'`)
).rows[0];
await denied(() =>
  command("session", {
    id: reviewRow.id,
    revision: reviewRow.revision,
    review_time: true,
    reason: "Installer tries to approve time",
  }),
);
await asUser(1);
await denied(() =>
  command("session", {
    id: reviewRow.id,
    revision: reviewRow.revision,
    started_at: t(-500),
    reason: "Outside shift",
  }),
);
await command("session", {
  id: reviewRow.id,
  revision: reviewRow.revision,
  review_time: true,
  reason: "Checked cleanup times, breaks and job attribution",
});
checks++;
assert.equal(
  (
    await db.query(
      `select review_required from custom_work_sessions where id='${id(67)}'`,
    )
  ).rows[0].review_required,
  false,
);
checks++;
// Corrections that invalidate attribution remain visible and excluded from benchmarks.
await db.exec(
  `reset role; update time_shifts set status='rejected' where id='${id(30)}'`,
);
assert.equal(
  (
    await db.query(
      `select count(*)::int n from custom_work_sessions where shift_id='${id(30)}' and not review_required`,
    )
  ).rows[0].n,
  0,
);
checks++;

await db.exec(
  `reset role; update projects set deleted_at=now() where id='${id(10)}'`,
);
await asUser(2);
assert.equal(
  (await db.query("select * from custom_work_units")).rows.length,
  0,
);
checks++;
await denied(() => command("unit", { ...unit, revision: 2 }));
await db.close();
console.log(
  `${checks} custom-work SQL checks passed. Existing auth/shift helpers are fixture stubs; no production writes.`,
);

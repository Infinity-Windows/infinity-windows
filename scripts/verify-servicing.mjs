// Disposable database: service permissions, timing, evidence and billing. No production writes.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(
  process.env.PGLITE_MODULE ?? "@electric-sql/pglite"
);
const db = new PGlite();
await db.exec(`
create role authenticated; create role anon; create role service_role; set check_function_bodies=off; create schema auth; create schema storage;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth,storage to authenticated,anon;
create table profiles(id uuid primary key,role text,active boolean default true,is_partner boolean default false,retired_at timestamptz,access_revoked_at timestamptz);
create table projects(id uuid primary key,deleted_at timestamptz,is_test boolean default false,status text default 'active',job_code text default 'TEST',name text default 'Fixture job');
create table project_openings(id uuid primary key,project_id uuid references projects,status text default 'installed',removed_at timestamptz);
create table windows(id uuid primary key,project_id uuid references projects);
create table service_cases(id uuid primary key,project_id uuid references projects);
create table time_shifts(id uuid primary key,profile_id uuid,project_id uuid,clock_in_at timestamptz,clock_out_at timestamptz,break_started_at timestamptz,status text,break_seconds int default 0);
create table toolbox_completions(profile_id uuid,signed_at timestamptz);
create table unit_sessions(id uuid primary key default gen_random_uuid(),profile_id uuid,opening_id uuid,started_at timestamptz default now(),ended_at timestamptz,end_reason text,role text default 'install',is_rework boolean default false);
create table task_sessions(id uuid primary key,profile_id uuid,opening_id uuid,started_at timestamptz,ended_at timestamptz);
create table opening_phases(started_by uuid,status text,paused_at timestamptz);
create table project_messages(id uuid primary key,project_id uuid references projects,author_id uuid references profiles,body text,mentions uuid[],created_at timestamptz default now());
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
grant select,insert on storage.objects to authenticated;
create function is_partner_user() returns boolean language sql security definer as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
create function _is_lead(p uuid) returns boolean language sql as $$select exists(select 1 from profiles where id=p and role in ('foreman','supervisor','owner'))$$;
create function is_test_profile(p uuid) returns boolean language sql as $$select false$$;
create function _end_open_session(p uuid,r text) returns void language sql as $$update unit_sessions set ended_at=now(),end_reason=r where profile_id=p and ended_at is null$$;
create function _has_open_redo(p uuid) returns boolean language sql as $$select false$$;
create function attach_sandbox_guards() returns void language sql as $$select$$;
grant select on profiles,projects to authenticated;
`);
for (const file of [
  "20261011000000_custom_work.sql",
  "20261017000000_servicing_visits.sql",
])
  await db.exec(
    await readFile(
      new URL("../supabase/migrations/" + file, import.meta.url),
      "utf8",
    ),
  );
await db.exec(
  "create trigger unit_sessions_follow_shift after update on time_shifts for each row execute function unit_sessions_follow_shift()",
);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let counter = 1000,
  checks = 0;
const at = (m) => new Date(Date.now() + m * 60000).toISOString();
async function asUser(n) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    id(n),
  ]);
  await db.exec("set role authenticated");
}
async function cmd(action, data, key = id(counter++)) {
  return (
    await db.query("select service_command($1,$2,$3) id", [key, action, data])
  ).rows[0].id;
}
async function deny(fn) {
  await assert.rejects(fn);
  checks++;
}
await db.query(
  "insert into profiles(id,role,is_partner) values($1,'owner',false),($2,'installer',false),($3,'installer',false),($4,'supervisor',false),($5,'supervisor',false),($6,'owner',true),($7,'foreman',false)",
  [1, 2, 3, 4, 5, 6, 7].map(id),
);
await db.query(
  "insert into projects(id,status) values($1,'completed'),($2,'active')",
  [id(10), id(11)],
);
await db.query(
  "insert into project_openings(id,project_id) values($1,$2),($3,$4)",
  [id(20), id(10), id(21), id(11)],
);
await db.query(
  "insert into time_shifts(id,profile_id,project_id,clock_in_at,status) values($1,$2,$3,$4,'open'),($5,$6,$3,$4,'open')",
  [id(30), id(2), id(10), at(-120), id(31), id(3)],
);
await asUser(2);
const visit = {
  id: id(40),
  project_id: id(10),
  details: { crew_names: "Worker A, Worker B", lodging: true },
};
assert.equal(await cmd("visit", visit, id(900)), id(40));
checks++;
assert.equal(await cmd("visit", visit, id(900)), id(40));
checks++;
await deny(() => cmd("visit", { ...visit, details: {} }, id(900)));
await db.exec("reset role");
assert.equal((await db.query("select * from project_messages")).rows.length, 1);
checks++;
assert.deepEqual(
  (
    await db.query("select mentions from project_messages")
  ).rows[0].mentions.sort(),
  [id(4), id(5)],
);
checks++;
await asUser(4);
await cmd("supervisor", { project_id: id(10), profile_id: id(5) });
await asUser(2);
await cmd("visit", { ...visit, id: id(41) });
await db.exec("reset role");
assert.deepEqual(
  (
    await db.query(
      "select mentions from project_messages order by created_at desc",
    )
  ).rows[0].mentions,
  [id(5)],
);
checks++;
await asUser(2);
await cmd("notify", { visit_id: id(40) });
await db.exec("reset role");
assert.equal((await db.query("select * from project_messages")).rows.length, 2);
checks++;
await asUser(2);
const unit = {
  id: id(50),
  visit_id: id(40),
  label: "7",
  type_label: "Sliding door",
  issue: "Binding hardware",
  facts: { material: "Vinyl" },
  opening_id: id(20),
};
await cmd("unit", unit);
checks++;
await deny(() => cmd("unit", { ...unit, id: id(51), opening_id: id(21) }));
await deny(() => cmd("unit", { ...unit, issue: "Stale edit" }));
const start = {
  id: id(60),
  visit_id: id(40),
  unit_id: id(50),
  shift_id: id(30),
  kind: "unit",
  stage: "Diagnosis",
  at: at(-60),
  expected_session_id: null,
};
await cmd("start", start);
checks++;
await deny(() => cmd("start", { ...start, id: id(61) }));
await cmd("start", {
  ...start,
  id: id(61),
  unit_id: null,
  kind: "idle",
  stage: "Idle time",
  description: "Getting replacement hardware",
  at: at(-45),
  expected_session_id: id(60),
});
checks++;
await asUser(3);
await cmd("start", { ...start, id: id(62), shift_id: id(31), at: at(-40) });
checks++;
await deny(() =>
  cmd("unit", { ...unit, revision: 1, issue: "Overwrite another worker" }),
);
await asUser(2);
await deny(() => cmd("finish", { visit_id: id(40), revision: 5 }));
await cmd("stop", {
  visit_id: id(40),
  expected_session_id: id(61),
  at: at(-30),
});
checks++;
await asUser(3);
await cmd("stop", {
  visit_id: id(40),
  expected_session_id: id(62),
  at: at(-30),
});
checks++;
await db.exec("reset role");
assert.equal(
  (await db.query("select status from projects where id=$1", [id(10)])).rows[0]
    .status,
  "completed",
);
checks++;
assert.equal(
  (await db.query("select status from project_openings where id=$1", [id(20)]))
    .rows[0].status,
  "installed",
);
checks++;
const revision = async () =>
  +(await db.query("select revision from service_visits where id=$1", [id(40)]))
    .rows[0].revision;
await asUser(2);
await cmd("finish", { visit_id: id(40), revision: await revision() });
checks++;
await deny(() => cmd("start", { ...start, id: id(63), at: at(-20) }));
const allocation = {
  manufacturer: 100,
  customer: 0,
  installer: 0,
  reason: "Factory hardware; trip entirely for this repair",
};
await deny(async () =>
  cmd("review", { visit_id: id(40), revision: await revision(), allocation }),
);
await asUser(4);
await deny(async () =>
  cmd("review", { visit_id: id(40), revision: await revision(), allocation }),
);
await cmd("unit", {
  ...unit,
  revision: 1,
  cause: "manufacturer",
  fail_point: "Hardware",
  repair: "Replaced factory roller",
  verification: "Slides freely and locks",
  memo_text: "Factory roller seized. Replaced and tested.",
  outcome: "resolved",
  evidence_exception: "Camera unavailable; reviewed typed explanation",
});
await deny(async () =>
  cmd("review", {
    visit_id: id(40),
    revision: await revision(),
    allocation: { ...allocation, manufacturer: 80 },
  }),
);
await cmd("review", {
  visit_id: id(40),
  revision: await revision(),
  allocation,
});
checks++;
await asUser(2);
await cmd("visit", {
  id: id(42),
  project_id: id(10),
  previous_visit_id: id(40),
  details: {},
});
checks++;
await cmd("unit", { ...unit, id: id(52), visit_id: id(42) });
checks++;
await cmd("start", {
  ...start,
  id: id(64),
  visit_id: id(42),
  unit_id: id(52),
  at: at(-20),
});
checks++;
await db.exec("reset role");
await db.query("update time_shifts set break_started_at=$1 where id=$2", [
  at(-15),
  id(30),
]);
assert.equal(
  (
    await db.query("select end_reason from service_time_sessions where id=$1", [
      id(64),
    ])
  ).rows[0].end_reason,
  "break",
);
checks++;
await db.exec(
  `insert into unit_sessions(profile_id,opening_id,started_at,ended_at,end_reason) values('${id(2)}','${id(20)}',now()-interval '4 hours',now()-interval '3 hours','break')`,
);
await db.query(
  "update time_shifts set break_started_at=null,break_seconds=600 where id=$1",
  [id(30)],
);
assert.equal(
  (await db.query("select * from unit_sessions where ended_at is null")).rows
    .length,
  0,
);
checks++;
await asUser(2);
await cmd("start", {
  ...start,
  id: id(65),
  visit_id: id(42),
  unit_id: id(52),
  at: at(-4),
});
await db.exec("reset role");
await db.query(
  "insert into task_sessions(id,profile_id,opening_id,started_at) values($1,$2,$3,$4)",
  [id(70), id(2), id(20), at(-3)],
);
assert.equal(
  (
    await db.query("select end_reason from service_time_sessions where id=$1", [
      id(65),
    ])
  ).rows[0].end_reason,
  "other_work",
);
checks++;
await asUser(2);
await cmd("start", {
  ...start,
  id: id(66),
  visit_id: id(42),
  unit_id: id(52),
  at: at(-2),
});
await db.exec("reset role");
await db.query(
  "update time_shifts set clock_out_at=now(),status='submitted' where id=$1",
  [id(30)],
);
assert.equal(
  (
    await db.query("select end_reason from service_time_sessions where id=$1", [
      id(66),
    ])
  ).rows[0].end_reason,
  "clock_out",
);
checks++;
await asUser(2);
await deny(() => db.exec("update service_visits set status='active'"));
await deny(() => cmd("supervisor", { project_id: id(10), profile_id: id(4) }));
await deny(() =>
  cmd("media", {
    visit_id: id(40),
    id: id(80),
    storage_path: `${id(3)}/${id(40)}/${id(80)}.webm`,
    filename: "voice.webm",
    kind: "voice",
    bytes: 100,
    content_type: "audio/webm",
  }),
);
for (const user of [6]) {
  await asUser(user);
  assert.equal((await db.query("select * from service_visits")).rows.length, 0);
  checks++;
  await deny(() => cmd("visit", { ...visit, id: id(90) }));
}
await db.exec("reset role; set role anon");
await deny(() => cmd("visit", visit));

// Replay after a payroll boundary: kept, flagged and reconciled rather than lost.
await db.exec("reset role");
await db.query(
  "insert into time_shifts(id,profile_id,project_id,clock_in_at,clock_out_at,status) values($1,$2,$3,$4,$5,'submitted')",
  [id(32), id(3), id(10), at(-20), at(-5)],
);
await asUser(3);
await cmd("start", {
  ...start,
  id: id(67),
  visit_id: id(42),
  unit_id: id(52),
  shift_id: id(32),
  at: at(-18),
});
let replay = (
  await db.query("select * from service_time_sessions where id=$1", [id(67)])
).rows[0];
assert.equal(replay.review_required, true);
assert.ok(replay.ended_at);
checks += 2;
await cmd("stop", {
  visit_id: id(42),
  expected_session_id: id(67),
  at: at(-8),
});
replay = (
  await db.query("select * from service_time_sessions where id=$1", [id(67)])
).rows[0];
assert.equal(replay.end_reason, "stop");
checks++;
const correction = {
  visit_id: id(42),
  id: id(67),
  expected_start: replay.started_at,
  expected_end: replay.ended_at,
  started_at: at(-18),
  ended_at: at(-8),
  reason: "Compared offline capture with paid shift",
};
await deny(() => cmd("review_time", correction));
await asUser(4);
await deny(() => cmd("review_time", { ...correction, ended_at: at(2) }));
await deny(() =>
  cmd("review_time", { ...correction, expected_start: at(-19) }),
);
await cmd("review_time", correction);
assert.equal(
  (
    await db.query(
      "select review_required from service_time_sessions where id=$1",
      [id(67)],
    )
  ).rows[0].review_required,
  false,
);
checks++;
// Historical ended service work also guards against a backdated installation timer.
await db.exec("reset role");
await deny(() =>
  db.query(
    "insert into task_sessions(id,profile_id,opening_id,started_at) values($1,$2,$3,$4)",
    [id(71), id(3), id(20), at(-10)],
  ),
);
// Simulate permissive pre-existing storage policies: restrictive bucket policies still win.
await db.exec(
  "grant update,delete on storage.objects to authenticated; create policy fixture_existing_storage on storage.objects for all to authenticated using(true) with check(true)",
);
await asUser(2);
const mediaPath = `${id(2)}/${id(40)}/${id(80)}.webm`;
await db.query(
  "insert into storage.objects(bucket_id,name) values('service-media',$1)",
  [mediaPath],
);
await cmd("media", {
  visit_id: id(40),
  unit_id: id(50),
  id: id(80),
  storage_path: mediaPath,
  filename: "voice.webm",
  kind: "voice",
  bytes: 100,
  content_type: "audio/webm",
});
checks++;
assert.equal(
  (
    await db.query("select reviewed_at from service_visits where id=$1", [
      id(40),
    ])
  ).rows[0].reviewed_at,
  null,
);
checks++;
await db.query("update storage.objects set name='overwritten' where name=$1", [
  mediaPath,
]);
await db.query("delete from storage.objects where name=$1", [mediaPath]);
assert.equal(
  (await db.query("select * from storage.objects where name=$1", [mediaPath]))
    .rows.length,
  1,
);
checks++;
await deny(() =>
  db.query(
    "insert into storage.objects(bucket_id,name) values('service-media',$1)",
    [`${id(3)}/${id(40)}/${id(81)}.webm`],
  ),
);
await asUser(6);
assert.equal((await db.query("select * from storage.objects")).rows.length, 0);
checks++;
await deny(() =>
  db.query(
    "insert into storage.objects(bucket_id,name) values('service-media',$1)",
    [`${id(6)}/${id(40)}/${id(81)}.webm`],
  ),
);
await db.exec('reset role');await db.query('update profiles set active=false where id=$1',[id(2)]);await asUser(2);
assert.ok((await db.query('select * from service_visits')).rows.length>0);checks++;
await cmd('visit',{...visit,id:id(94),details:{}});checks++;
for (const state of [
  "active=true,retired_at=now()",
  "retired_at=null,access_revoked_at=now()",
]) {
  await db.exec("reset role");
  await db.exec(`update profiles set ${state} where id='${id(2)}'`);
  await asUser(2);
  assert.equal((await db.query("select * from service_visits")).rows.length, 0);
  checks++;
  await deny(() => cmd("visit", { ...visit, id: id(93) }));
}
await db.exec("reset role");
await db.exec(
  "alter table time_shifts enable row level security; grant select on time_shifts to authenticated; create policy fixture_own_payroll on time_shifts for select to authenticated using(profile_id=auth.uid())",
);
await asUser(3);
assert.equal(
  (await db.query("select * from time_shifts where id=$1", [id(30)])).rows
    .length,
  0,
);
checks++;
const scopedBounds = (
  await db.query("select service_shift_bounds($1) bounds", [id(40)])
).rows[0].bounds;
assert.ok(scopedBounds[id(30)]);
assert.deepEqual(Object.keys(scopedBounds[id(30)]).sort(), [
  "break_seconds",
  "clock_in_at",
  "clock_out_at",
  "project_id",
  "status",
]);
checks += 2;
await asUser(6);
assert.deepEqual(
  (await db.query("select service_shift_bounds($1) bounds", [id(40)])).rows[0]
    .bounds,
  {},
);
checks++;
// Service earlier in the shift must not suppress a later installation break/resume.
await db.exec('reset role');
await db.query("insert into project_openings(id,project_id,status) values($1,$2,'installing')",[id(22),id(10)]);
await db.query('insert into unit_sessions(profile_id,opening_id,started_at) values($1,$2,now())',[id(3),id(22)]);
await db.query('update time_shifts set break_started_at=now() where id=$1',[id(31)]);
await db.query('update time_shifts set break_started_at=null,break_seconds=break_seconds+1 where id=$1',[id(31)]);
assert.equal((await db.query('select * from unit_sessions where profile_id=$1 and ended_at is null',[id(3)])).rows.length,1);checks++;
await db.close();
console.log(
  `${checks} service database checks passed, using isolated fixtures.`,
);

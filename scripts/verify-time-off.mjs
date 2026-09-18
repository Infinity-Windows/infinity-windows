// Real PostgreSQL execution in a disposable PGlite database. No live records.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(
  process.env.PGLITE_MODULE ?? "@electric-sql/pglite"
);
const db = new PGlite();
await db.exec(`
 create role authenticated;create role anon;create role service_role;create schema auth;set check_function_bodies=off;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to authenticated,anon,service_role;
 create table profiles(id uuid primary key,display_name text,role text,active boolean default true,is_partner boolean default false,retired_at timestamptz,access_revoked_at timestamptz);
 create function is_partner_user() returns boolean language sql security definer as $$select coalesce((select is_partner from profiles where id=auth.uid()),false)$$;
 create function my_role_rank() returns integer language sql security definer as $$select case role when 'installer' then 1 when 'foreman' then 2 when 'supervisor' then 3 when 'owner' then 4 else 0 end from profiles where id=auth.uid()$$;
 create table time_shifts(id uuid primary key,profile_id uuid references profiles,clock_out_at timestamptz,status text,break_type text,break_started_at timestamptz);
 create table schedule_assignments(id uuid,project_id uuid,status text,start_date date,end_date date);
 create table schedule_assignment_members(assignment_id uuid,profile_id uuid);
 create table service_job_supervisors(project_id uuid,profile_id uuid);
`);
await db.exec(
  await readFile(
    new URL(
      "../supabase/migrations/20261019000000_time_off_and_lunch.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
let checks = 0;
const ok = (a, b) => {
  assert.deepEqual(a, b);
  checks++;
};
async function denied(fn) {
  await assert.rejects(fn);
  checks++;
}
async function user(n) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    id(n),
  ]);
  await db.exec("set role authenticated");
}
for (const [n, role, partner] of [
  [1, "installer", false],
  [2, "foreman", false],
  [3, "supervisor", false],
  [4, "owner", false],
  [5, "supervisor", true],
  [6, "installer", false],
])
  await db.query(
    "insert into profiles(id,display_name,role,is_partner) values($1,$2,$3,$4)",
    [id(n), `Fixture ${n}`, role, partner],
  );
await user(1);
const req = (n, kind, start = "2026-09-18", end = start) =>
  db.query("select request_time_off($1,$2,$3,$4)", [id(n), kind, start, end]);
await req(100, "sick");
await req(100, "sick");
ok(await rows("select status from time_off_requests"), [
  { status: "approved" },
]);
await denied(() => req(101, "vacation")); // overlapping day
await denied(() => db.query("update time_off_requests set status='approved'"));
await req(102, "vacation", "2026-10-01", "2026-10-03");
await req(103, "other", "2026-10-05");
await denied(() =>
  db.query("select review_time_off($1,'approved')", [id(102)]),
);
await user(2);
await denied(() =>
  db.query("select review_time_off($1,'approved')", [id(102)]),
);
await user(6);
ok((await rows("select id from time_off_requests")).length, 0);
await denied(() => req(100, "sick"));
await user(5);
await denied(() => req(105, "sick"));
ok((await rows("select id from time_off_requests")).length, 0);
await user(3);
ok((await rows("select id from crew_reminders")).length, 3);
await db.query("select review_time_off($1,'approved')", [id(102)]);
await db.query("select review_time_off($1,'approved')", [id(102)]); // retry
await db.query("select review_time_off($1,'declined')", [id(103)]);
await user(1);
ok(
  (await rows("select status from time_off_requests where id=$1", [id(102)]))[0]
    .status,
  "approved",
);
await db.query("select review_time_off($1,'canceled')", [id(100)]);
await req(104, "sick"); // cancellation releases dates
await denied(() => req(106, "sick", "2026-10-02", "2026-10-01"));
await denied(() => req(106, "sick", "2026-10-02", "2028-10-01"));
await denied(() =>
  db.query("select * from claim_crew_reminders($1)", [id(900)]),
);
await db.exec("reset role");
for (const [n, minutes, type, status] of [
  [201, 29, "lunch", "open"],
  [202, 31, "lunch", "open"],
  [203, 31, "rest", "open"],
  [204, 31, "lunch", "submitted"],
])
  await db.query(
    "insert into time_shifts values($1,$2,null,$3,$4,now()-make_interval(mins=>$5))",
    [id(n), id(1), status, type, minutes],
  );
await db.exec("set role service_role");
const claimed = await rows("select * from claim_crew_reminders($1)", [id(900)]);
ok(
  claimed.filter((x) => x.shift_id !== null).map((x) => x.shift_id),
  [id(202)],
);
ok((await rows("select * from claim_crew_reminders($1)", [id(901)])).length, 0);
const lunch = claimed.find((x) => x.shift_id === id(202));
await db.query("select finish_crew_reminder($1,$2,true)", [lunch.id, id(901)]); // foreign lease does nothing
await db.exec("reset role");
ok(
  (await rows("select sent_at from crew_reminders where id=$1", [lunch.id]))[0]
    .sent_at,
  null,
);
await db.exec("set role service_role");
await db.query("select finish_crew_reminder($1,$2,true)", [lunch.id, id(900)]);
await db.exec("reset role");
ok(
  (
    await rows(
      "select sent_at is not null sent from crew_reminders where id=$1",
      [lunch.id],
    )
  )[0].sent,
  true,
);
// Ended breaks are never reclaimed, even if push had failed before the lease expired.
await db.exec(
  "update crew_reminders set sent_at=null,lease_until=now()-interval '1 minute';update time_shifts set break_started_at=null where id='" +
    id(202) +
    "'",
);
await db.exec("set role service_role");
ok(
  (await rows("select * from claim_crew_reminders($1)", [id(902)])).filter(
    (x) => x.shift_id !== null,
  ).length,
  0,
);
console.log(`Time off and lunch: ${checks} database checks passed.`);
await db.close();

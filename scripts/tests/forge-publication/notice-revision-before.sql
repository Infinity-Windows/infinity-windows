-- Include a genuinely connected non-null end time; end-time.sql leaves its
-- existing plan with a null end time. Capture both shapes before adding the
-- server-only notice field so compatibility is measured, not inferred.
insert into schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,status)
values ('00000000-0000-0000-0000-000000001350','00000000-0000-0000-0000-000000000101','2026-12-30','2026-12-30','07:00','15:00','draft');
insert into schedule_assignment_members(assignment_id,profile_id,role)
values ('00000000-0000-0000-0000-000000001350','00000000-0000-0000-0000-000000000001','installer');
insert into trips(id,project_id,name,start_date,end_date,status)
values ('00000000-0000-0000-0000-000000001351','00000000-0000-0000-0000-000000000101','Non-null end time fixture','2026-12-30','2026-12-30','draft');
insert into trip_crew(trip_id,profile_id,role)
values ('00000000-0000-0000-0000-000000001351','00000000-0000-0000-0000-000000000001','crew');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select workflow_create_plan('00000000-0000-0000-0000-000000001352','Non-null end time plan',array['00000000-0000-0000-0000-000000001350']::uuid[],array['00000000-0000-0000-0000-000000001351']::uuid[]);
reset role;
create table fixture_old_snapshots2 as select id,workflow_snapshot(id) as snapshot from workflow_plans;

-- Existing-row baseline: a standalone published row and a standalone draft
-- row, both inserted BEFORE the migration exists (no notice_revision column,
-- no trigger). The column's own ALTER TABLE ... DEFAULT 0 is what every
-- pre-migration row must read as afterward, regardless of status — never a
-- conditional backfill that would invent a historical "first publish".
insert into schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,status,note,published_at)
values
 ('00000000-0000-0000-0000-000000001310','00000000-0000-0000-0000-000000000101','2026-12-10','2026-12-10','08:00','12:00','published','Pre-migration published baseline',now()),
 ('00000000-0000-0000-0000-000000001311','00000000-0000-0000-0000-000000000101','2026-12-11','2026-12-11','08:00',null,'draft','Pre-migration draft baseline',null);

-- An inactive crew member, created pre-migration (profiles are untouched by
-- this migration) for the forced-rollback check in notice-revision.sql: a
-- connected publish whose member list fails the active-crew check must roll
-- back the whole transaction, including any trigger-side notice_revision
-- bump already applied to the assignment row earlier in the same statement.
insert into profiles(id,role,active) values ('00000000-0000-0000-0000-000000001301','installer',false);

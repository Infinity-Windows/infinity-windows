-- pg_temp resets per psql connection (each run_sql is a fresh docker exec),
-- so these are redefined exactly as end-time.sql does for its own checks.
create function pg_temp.ok(p boolean,label text) returns void language plpgsql as $$
begin if p is distinct from true then raise exception 'FAILED: %',label; end if; end $$;
create function pg_temp.denied(statement text,expected text default null) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if expected is not null and position(expected in sqlerrm)=0 then
      raise exception 'FAILED: expected error %, received %',expected,sqlerrm;
    end if;
    return;
  end;
  raise exception 'FAILED: expected rejection: %',statement;
end $$;

-- 1. Every real pre-migration plan (null and non-null end_time alike) keeps
--    its exact source fingerprint — the new column is omitted, not merely
--    defaulted, from workflow_snapshot.
select pg_temp.ok((select bool_and(snapshot=workflow_snapshot(id)) from fixture_old_snapshots2),'pre-migration connected source fingerprints unchanged (notice_revision omitted)');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000001353',workflow_review_plan(id)->>'review_token',true)
from workflow_plans where id='00000000-0000-0000-0000-000000001352';
select pg_temp.ok((select notice_revision=1 and end_time='15:00' from schedule_assignments where id='00000000-0000-0000-0000-000000001350'),'pre-migration connected plan with a non-null end time remains publishable');
reset role;

-- 2. Existing live rows (published or draft) get the column's own default,
--    never a synthesized "first publish".
select pg_temp.ok((select notice_revision=0 from schedule_assignments where id='00000000-0000-0000-0000-000000001310'),'pre-migration published row defaults to 0');
select pg_temp.ok((select notice_revision=0 from schedule_assignments where id='00000000-0000-0000-0000-000000001311'),'pre-migration draft row defaults to 0');
select pg_temp.ok((select notice_revision=0 from schedule_assignments where id='00000000-0000-0000-0000-000000000605'),'the pre-migration connected row (plan 903) also defaults to 0');

-- 3. Insert semantics: a fresh draft starts at 0; a direct published insert
--    is forced to 1 regardless of a forged supplied value; an explicit null
--    on insert never reaches the not-null column.
insert into schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,status,note)
values ('00000000-0000-0000-0000-000000001312','00000000-0000-0000-0000-000000000101','2026-12-12','2026-12-12','08:00','12:00','draft','New draft insert, post-migration');
select pg_temp.ok((select notice_revision=0 from schedule_assignments where id='00000000-0000-0000-0000-000000001312'),'a fresh draft insert starts at 0');

insert into schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,status,note,published_at,notice_revision)
values ('00000000-0000-0000-0000-000000001313','00000000-0000-0000-0000-000000000101','2026-12-13','2026-12-13','08:00','12:00','published','Direct publish insert, forged revision supplied',now(),777);
select pg_temp.ok((select notice_revision=1 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'a direct published insert is forced to 1, ignoring a forged supplied value');

insert into schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,status,note,notice_revision)
values ('00000000-0000-0000-0000-000000001314','00000000-0000-0000-0000-000000000101','2026-12-14','2026-12-14','08:00','12:00','draft','Null revision on insert',null);
select pg_temp.ok((select notice_revision=0 from schedule_assignments where id='00000000-0000-0000-0000-000000001314'),'an explicit null notice_revision on insert is normalized, never left null');

-- 4. Published-row edits: every date/time field change bumps, including a
--    seconds-only change and clearing end_time to null; cosmetic fields,
--    member changes and a same-timing republish all stay quiet; a forged
--    revision (alone, or alongside a real change) is always overwritten;
--    reverting to an earlier value still mints a new, distinct occurrence.
update schedule_assignments set start_date='2026-12-12' where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=2 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'start_date change bumps');
update schedule_assignments set end_date='2026-12-16' where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=3 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'end_date change bumps');
update schedule_assignments set start_time='09:00' where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=4 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'start_time change bumps');
update schedule_assignments set end_time='13:00' where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=5 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'end_time change bumps');
update schedule_assignments set end_time='13:00:30' where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=6 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'a seconds-only change to a genuinely different value still bumps');
update schedule_assignments set end_time=null where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=7 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'clearing end_time bumps, even though it is the one field omitted from the connected snapshot');
update schedule_assignments set start_time='09:00:00' where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=7 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'an equivalent typed start_time (different text, same stored value) stays quiet');
update schedule_assignments set color='#112233',note='cosmetic only',updated_at=now() where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=7 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'color/note/updated_at alone stay quiet');
insert into schedule_assignment_members(assignment_id,profile_id,role) values ('00000000-0000-0000-0000-000000001313','00000000-0000-0000-0000-000000000001','installer');
select pg_temp.ok((select notice_revision=7 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'a member change touches a different table and stays quiet');
update schedule_assignments set status='published',published_at=now() where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=7 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'republishing with status already published and unchanged timing stays quiet');
update schedule_assignments set notice_revision=999 where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=7 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'a revision-only UPDATE can never forge the counter');
update schedule_assignments set start_time='10:00',notice_revision=0 where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=8 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'a real timing change bumps despite a forged-low supplied revision alongside it');
update schedule_assignments set start_time='09:00' where id='00000000-0000-0000-0000-000000001313';
select pg_temp.ok((select notice_revision=9 from schedule_assignments where id='00000000-0000-0000-0000-000000001313'),'reverting to an earlier value (A->B->A) is still a new, distinct occurrence');

-- 5. A draft row's timing edits stay quiet; its first publish is the bump.
update schedule_assignments set start_time='11:00' where id='00000000-0000-0000-0000-000000001312';
select pg_temp.ok((select notice_revision=0 from schedule_assignments where id='00000000-0000-0000-0000-000000001312'),'a draft row''s timing edit stays quiet');
update schedule_assignments set status='published',published_at=now() where id='00000000-0000-0000-0000-000000001312';
select pg_temp.ok((select notice_revision=1 from schedule_assignments where id='00000000-0000-0000-0000-000000001312'),'draft -> published is itself a bump (initial publish)');

-- 6. RLS may silently match zero rows on an installer UPDATE. Assert both
-- that no row was updated and that neither timing nor revision changed.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
with edited as (
  update schedule_assignments set start_time='11:00',notice_revision=55
  where id='00000000-0000-0000-0000-000000001310' returning id
) select pg_temp.ok((select count(*)=0 from edited),'installer UPDATE has zero writable rows');
reset role;
select pg_temp.ok((select start_time='08:00' and notice_revision=0 from schedule_assignments where id='00000000-0000-0000-0000-000000001310'),'installer cannot change timing or notice revision');

-- Complete work and trip drafts for the late-failure scenario below.
insert into schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,status,created_by)
values ('00000000-0000-0000-0000-000000001330','00000000-0000-0000-0000-000000000101','2026-12-20','2026-12-20','07:00','12:00','draft','00000000-0000-0000-0000-000000000004');
insert into schedule_assignment_members(assignment_id,profile_id,role) values ('00000000-0000-0000-0000-000000001330','00000000-0000-0000-0000-000000000001','installer');
insert into trips(id,project_id,name,start_date,end_date,status)
values ('00000000-0000-0000-0000-000000001333','00000000-0000-0000-0000-000000000101','Rollback trip fixture','2026-12-20','2026-12-20','draft');
insert into trip_crew(trip_id,profile_id,role)
values ('00000000-0000-0000-0000-000000001333','00000000-0000-0000-0000-000000000001','crew');

-- 7. The connected workflow: a real timing publish on an already-published,
--    pre-migration row bumps; the exact same publish request does not
--    duplicate it; a note-only publish stays quiet; reverting to the
--    original timing through the real publish RPC is still a distinct
--    occurrence; the republished snapshot still omits notice_revision — the
--    same real functions end-time.sql exercised on this same plan/row, not a
--    source-mirror assertion.
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
-- A retry must present the SAME review_token as the original call, not one
-- recomputed afterward — publish itself rewrites `draft` to the post-publish
-- snapshot, so a token recomputed after the fact would no longer match the
-- fingerprint workflow_publish_plan stored for this request_id and would
-- raise "used for different changes" instead of returning the cached result.
-- Mirrors concurrency-setup.sql's own fixture_review_token for the same reason.
select workflow_save_draft(id,revision,jsonb_set(draft,'{assignments,0,start_time}','"07:00"')) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select set_config('test.notice_review_token',workflow_review_plan(id)->>'review_token',false) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000001320',current_setting('test.notice_review_token'),true) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select pg_temp.ok((select notice_revision=1 from schedule_assignments where id='00000000-0000-0000-0000-000000000605'),'a connected timing publish bumps the already-published row');
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000001320',current_setting('test.notice_review_token'),true) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select pg_temp.ok((select notice_revision=1 from schedule_assignments where id='00000000-0000-0000-0000-000000000605'),'retrying the exact same publish request does not duplicate the occurrence');
select workflow_save_draft(id,revision,jsonb_set(draft,'{assignments,0,note}','"Connected note-only edit"')) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000001321',workflow_review_plan(id)->>'review_token',true) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select pg_temp.ok((select notice_revision=1 from schedule_assignments where id='00000000-0000-0000-0000-000000000605'),'a note-only connected publish stays quiet');
select workflow_save_draft(id,revision,jsonb_set(draft,'{assignments,0,start_time}','"06:30"')) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000001322',workflow_review_plan(id)->>'review_token',true) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select pg_temp.ok((select notice_revision=2 from schedule_assignments where id='00000000-0000-0000-0000-000000000605'),'reverting to the original start_time through the connected publish path is still a new occurrence');
select pg_temp.ok((select not ((source_snapshot->'assignments'->0) ? 'notice_revision') from workflow_plans where id='00000000-0000-0000-0000-000000000903'),'the republished connected snapshot still omits notice_revision');

-- 8. A late failure inside the same publish transaction (an inactive crew
--    member, caught after schedule_assignments is already updated) rolls
--    back everything, including the trigger's bump made earlier in that
--    same statement. Still under the same supervisor role switch as section 7.
select workflow_create_plan('00000000-0000-0000-0000-000000001331','Notice rollback fixture',array['00000000-0000-0000-0000-000000001330']::uuid[],array['00000000-0000-0000-0000-000000001333']::uuid[]);
select workflow_save_draft(id,revision,jsonb_set(jsonb_set(draft,'{assignments,0,start_time}','"08:00"'),'{assignments,0,members}','[{"profile_id":"00000000-0000-0000-0000-000000001301","role":"installer"}]'::jsonb)) from workflow_plans where id='00000000-0000-0000-0000-000000001331';
select pg_temp.denied($q$select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000001332',workflow_review_plan(id)->>'review_token',true) from workflow_plans where id='00000000-0000-0000-0000-000000001331'$q$,'Choose active internal crew members.');
select pg_temp.ok((select status='draft' and notice_revision=0 and start_time='07:00' from schedule_assignments where id='00000000-0000-0000-0000-000000001330'),'a late failure (inactive crew member) rolls back the whole publish, including this transaction''s own trigger bump');
select pg_temp.ok((select count(*)=1 and bool_and(profile_id='00000000-0000-0000-0000-000000000001') from schedule_assignment_members where assignment_id='00000000-0000-0000-0000-000000001330'),'the member delete/insert inside the same failed transaction also rolled back');
reset role;

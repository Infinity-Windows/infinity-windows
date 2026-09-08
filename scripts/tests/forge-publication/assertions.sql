-- All fixture IDs/data are synthetic. The previously-created pg_temp functions
-- are session-local, so define assertions in this connection too.
create function pg_temp.ok(p boolean,label text) returns void language plpgsql as $$
begin if p is distinct from true then raise exception 'FAILED: %',label; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin
 begin execute statement; exception when others then return; end;
 raise exception 'FAILED: expected rejection: %',statement;
end $$;
update trips set project_id='00000000-0000-0000-0000-000000000101' where id='00000000-0000-0000-0000-000000000202';
-- One unrelated draft must never be picked up by connected publication.
insert into schedule_assignments(id,project_id,start_date,end_date) values
 ('00000000-0000-0000-0000-000000000602','00000000-0000-0000-0000-000000000101','2026-10-01','2026-10-02');
set role authenticated;
select pg_temp.denied($q$truncate workflow_plans cascade$q$);
select pg_temp.denied($q$select * from workflow_publish_requests$q$);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select pg_temp.denied($q$select workflow_create_plan('00000000-0000-0000-0000-000000000901','Crew plan',array['00000000-0000-0000-0000-000000000601']::uuid[],array['00000000-0000-0000-0000-000000000202']::uuid[])$q$);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select workflow_create_plan('00000000-0000-0000-0000-000000000901','Crew plan',array['00000000-0000-0000-0000-000000000601']::uuid[],array['00000000-0000-0000-0000-000000000202']::uuid[]);
-- Retry create preserves one plan; another request cannot steal linked records.
select workflow_create_plan('00000000-0000-0000-0000-000000000901','Crew plan',array['00000000-0000-0000-0000-000000000601']::uuid[],array['00000000-0000-0000-0000-000000000202']::uuid[]);
select pg_temp.ok((select count(*)=1 from workflow_plans),'create retry');
select pg_temp.denied($q$select workflow_create_plan('00000000-0000-0000-0000-000000000902','Other plan',array['00000000-0000-0000-0000-000000000601']::uuid[],array['00000000-0000-0000-0000-000000000202']::uuid[])$q$);
select pg_temp.denied($q$update trips set notes='bypass' where id='00000000-0000-0000-0000-000000000202'$q$);
select pg_temp.denied($q$update schedule_assignments set status='published' where id='00000000-0000-0000-0000-000000000601'$q$);
select pg_temp.denied($q$delete from trip_crew where trip_id='00000000-0000-0000-0000-000000000202'$q$);
select pg_temp.denied($q$insert into flights(trip_id) values ('00000000-0000-0000-0000-000000000202')$q$);
select pg_temp.denied($q$update workflow_plans set revision=99$q$);
select pg_temp.denied($q$delete from storage.objects where name='00000000-0000-0000-0000-000000000202/draft.pdf'$q$);
select pg_temp.denied($q$update storage.objects set name='other.pdf' where name='00000000-0000-0000-0000-000000000202/draft.pdf'$q$);
select pg_temp.denied($q$insert into storage.objects(bucket_id,name) values ('trip-attachments','00000000-0000-0000-0000-000000000202/new.pdf')$q$);
select pg_temp.denied($q$select workflow_save_draft(id,revision,jsonb_set(draft,'{assignments,0,members}','null')) from workflow_plans$q$);
select pg_temp.denied($q$select workflow_save_draft(id,revision,jsonb_set(draft,'{trips,0,crew}','null')) from workflow_plans$q$);
-- This parent draft preserves weekend travel dates independently of work.
select workflow_save_draft(id,revision,jsonb_set(jsonb_set(draft,'{assignments,0,start_date}','"2026-09-07"'),'{trips,0,trip,start_date}','"2026-09-05"')) from workflow_plans;
select pg_temp.ok((select start_date='2026-09-01' from trips where id='00000000-0000-0000-0000-000000000202'),'working draft did not change instructions');
select pg_temp.denied($q$select workflow_save_draft(id,1,draft) from workflow_plans$q$);
select set_config('test.review_token',workflow_review_plan(id)->>'review_token',false) from workflow_plans;
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000911',current_setting('test.review_token')) from workflow_plans;
select workflow_publish_plan(id,2,'00000000-0000-0000-0000-000000000911',current_setting('test.review_token')) from workflow_plans;
select pg_temp.ok((select status='published' and start_date='2026-09-07' from schedule_assignments where id='00000000-0000-0000-0000-000000000601'),'work published');
select pg_temp.ok((select status='draft' from schedule_assignments where id='00000000-0000-0000-0000-000000000602'),'unrelated draft untouched');
select pg_temp.ok((select status='published' and start_date='2026-09-05' from trips where id='00000000-0000-0000-0000-000000000202'),'travel published independently');
select pg_temp.ok((select count(*)=1 from workflow_plan_revisions),'one immutable revision');
select pg_temp.ok((select count(*)=3 from workflow_notice_outbox),'recipient union queued once');
select pg_temp.denied($q$update workflow_plan_revisions set snapshot='{}'$q$);
-- A second publish request is not a substitute for a new draft.
select pg_temp.denied($q$select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000912',workflow_review_plan(id)->>'review_token') from workflow_plans$q$);
select pg_temp.denied($q$select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000911','changed-token') from workflow_plans$q$);
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select pg_temp.ok((select count(*)=0 from workflow_plans),'crew cannot read manager draft');
select pg_temp.ok((select count(*)=0 from workflow_plan_revisions),'crew cannot read private snapshots');
select pg_temp.ok((select count(*)=1 from workflow_my_trip_links()),'crew explicit trip link');
select pg_temp.denied($q$select workflow_review_plan('00000000-0000-0000-0000-000000000901')$q$);
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000006',false);
select pg_temp.ok((select count(*)=0 from workflow_my_trip_links()),'partner has no links');
select pg_temp.denied($q$select workflow_review_plan('00000000-0000-0000-0000-000000000901')$q$);
-- Manager drafts a removal; crew keeps the old published roster until publish.
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select workflow_save_draft(id,revision,jsonb_set(draft,'{trips,0,crew}',jsonb_build_array(jsonb_build_object('profile_id','00000000-0000-0000-0000-000000000002','role','crew')))) from workflow_plans;
select pg_temp.ok((select count(*)=3 from trip_crew where trip_id='00000000-0000-0000-0000-000000000202'),'draft removal not live');
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000913',workflow_review_plan(id)->>'review_token') from workflow_plans;
select pg_temp.ok((select count(*)=1 from trip_crew where trip_id='00000000-0000-0000-0000-000000000202'),'published removal live');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select pg_temp.ok((select count(*)=0 from trips where id='00000000-0000-0000-0000-000000000202'),'removed traveler loses trip');
select pg_temp.ok((select count(*)=0 from storage.objects where name='00000000-0000-0000-0000-000000000202/draft.pdf'),'removed traveler loses file access');
select pg_temp.ok((select count(*)=0 from workflow_my_trip_links()),'removed traveler loses navigation');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000914',workflow_review_plan(id)->>'review_token',false,true) from workflow_plans;
select pg_temp.ok((select status='canceled' from schedule_assignments where id='00000000-0000-0000-0000-000000000601'),'cancellation work');
select pg_temp.ok((select status='draft' from trips where id='00000000-0000-0000-0000-000000000202'),'cancellation travel');
select pg_temp.ok((select count(*)=3 from workflow_plan_revisions),'history retained');
select pg_temp.denied($q$select workflow_discard_plan(id,revision) from workflow_plans$q$);
reset role;

-- Independent rotations plus a real competing crew/vehicle booking.
insert into trips(id,project_id,name,start_date,end_date) values
 ('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-000000000101','Rotation A','2026-09-30','2026-10-02'),
 ('00000000-0000-0000-0000-000000000205','00000000-0000-0000-0000-000000000101','Rotation B','2026-10-02','2026-10-05');
insert into trip_crew(trip_id,profile_id) select t.id,p.id from trips t cross join profiles p where t.id in ('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-000000000205') and p.id='00000000-0000-0000-0000-000000000001';
insert into schedule_assignments(id,project_id,start_date,end_date) values
 ('00000000-0000-0000-0000-000000000603','00000000-0000-0000-0000-000000000101','2026-10-03','2026-10-04'),
 ('00000000-0000-0000-0000-000000000604','00000000-0000-0000-0000-000000000101','2026-10-01','2026-10-02');
insert into schedule_assignment_members(assignment_id,profile_id,role) select id,'00000000-0000-0000-0000-000000000001','installer' from schedule_assignments where id in ('00000000-0000-0000-0000-000000000602','00000000-0000-0000-0000-000000000603','00000000-0000-0000-0000-000000000604');
insert into vehicle_project_assignments(id,project_id,assignment_id,vehicle_id,start_date,end_date) values
 ('00000000-0000-0000-0000-000000000703','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000602','00000000-0000-0000-0000-000000000750','2026-10-01','2026-10-02'),
 ('00000000-0000-0000-0000-000000000704','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000604','00000000-0000-0000-0000-000000000750','2026-10-01','2026-10-02');
set role authenticated;
select workflow_create_plan('00000000-0000-0000-0000-000000000902','Rotations',array['00000000-0000-0000-0000-000000000602','00000000-0000-0000-0000-000000000603']::uuid[],array['00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-000000000205']::uuid[]);
select pg_temp.ok(jsonb_array_length(workflow_review_plan('00000000-0000-0000-0000-000000000902')->'conflicts')=2,'crew and vehicle conflicts surfaced');
select set_config('test.conflict_token',workflow_review_plan('00000000-0000-0000-0000-000000000902')->>'review_token',false);
select pg_temp.denied($q$select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000915',workflow_review_plan(id)->>'review_token',true) from workflow_plans where id='00000000-0000-0000-0000-000000000902'$q$);
-- A change to conflicting dates still overlapping must invalidate review.
update schedule_assignments set end_date='2026-10-01' where id='00000000-0000-0000-0000-000000000604';
select pg_temp.ok(workflow_review_plan('00000000-0000-0000-0000-000000000902')->>'review_token'<>current_setting('test.conflict_token'),'changed conflict dates invalidate review');
delete from vehicle_project_assignments where id='00000000-0000-0000-0000-000000000704';
select pg_temp.denied($q$select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000915',current_setting('test.conflict_token'),true) from workflow_plans where id='00000000-0000-0000-0000-000000000902'$q$);
select pg_temp.denied($q$select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000915',workflow_review_plan(id)->>'review_token') from workflow_plans where id='00000000-0000-0000-0000-000000000902'$q$);
-- Invalid crew on the second trip fails after work and the first trip were
-- materialized inside the function. None of those writes may survive failure.
select workflow_save_draft(id,revision,jsonb_set(draft,'{trips,1,crew,0,profile_id}','"00000000-0000-0000-0000-000000000006"')) from workflow_plans where id='00000000-0000-0000-0000-000000000902';
select pg_temp.denied($q$select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000915',workflow_review_plan(id)->>'review_token',true) from workflow_plans where id='00000000-0000-0000-0000-000000000902'$q$);
select pg_temp.ok((select bool_and(status='draft') from schedule_assignments where id in ('00000000-0000-0000-0000-000000000602','00000000-0000-0000-0000-000000000603')),'failed publication rolled back work');
select pg_temp.ok((select bool_and(status='draft') from trips where id in ('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-000000000205')),'failed publication rolled back all trips');
select pg_temp.ok((select count(*)=0 from workflow_notice_outbox where plan_id='00000000-0000-0000-0000-000000000902'),'failed publication queued nothing');
select workflow_save_draft(id,revision,jsonb_set(draft,'{trips,1,crew,0,profile_id}','"00000000-0000-0000-0000-000000000001"')) from workflow_plans where id='00000000-0000-0000-0000-000000000902';
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000000915',workflow_review_plan(id)->>'review_token',true) from workflow_plans where id='00000000-0000-0000-0000-000000000902';
select pg_temp.ok((select count(*)=1 from workflow_notice_outbox where plan_id='00000000-0000-0000-0000-000000000902'),'one recipient despite multiple rotations');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
select pg_temp.ok((select count(*)=4 and count(distinct trip_id)=2 from workflow_my_trip_links()),'two explicit rotations per work block, no last-trip-wins');
select pg_temp.denied($q$select workflow_claim_notices('00000000-0000-0000-0000-000000000902',gen_random_uuid())$q$);
reset role;
-- Service worker claims are exclusive; failed or expired claims can be retried.
set role service_role;
select pg_temp.ok((select count(*)=1 from workflow_claim_notices('00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-000000000950')),'first worker claims');
select pg_temp.ok((select count(*)=0 from workflow_claim_notices('00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-000000000951')),'second worker cannot claim live lease');
select workflow_finish_notice(id,'00000000-0000-0000-0000-000000000951',true) from workflow_notice_outbox where plan_id='00000000-0000-0000-0000-000000000902';
select pg_temp.ok((select state='sending' from workflow_notice_outbox where plan_id='00000000-0000-0000-0000-000000000902'),'wrong lease cannot acknowledge');
select workflow_finish_notice(id,'00000000-0000-0000-0000-000000000950',false) from workflow_notice_outbox where plan_id='00000000-0000-0000-0000-000000000902';
select pg_temp.ok((select count(*)=1 from workflow_claim_notices('00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-000000000951')),'failed notice retried');
update workflow_notice_outbox set lease_until=now()-interval '1 second' where plan_id='00000000-0000-0000-0000-000000000902';
select pg_temp.ok((select count(*)=1 from workflow_claim_notices('00000000-0000-0000-0000-000000000902','00000000-0000-0000-0000-000000000952')),'crashed worker lease recovered');
select workflow_finish_notice(id,'00000000-0000-0000-0000-000000000952',true) from workflow_notice_outbox where plan_id='00000000-0000-0000-0000-000000000902';
select pg_temp.ok((select count(*)=0 from workflow_claim_notices('00000000-0000-0000-0000-000000000902',gen_random_uuid())),'sent notices not redelivered');
reset role;

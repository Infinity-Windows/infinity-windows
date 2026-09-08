create function pg_temp.ok(p boolean,label text) returns void language plpgsql as $$
begin if p is distinct from true then raise exception 'FAILED: %',label; end if; end $$;
create function pg_temp.denied(statement text) returns void language plpgsql as $$
begin begin execute statement; exception when others then return; end; raise exception 'FAILED: expected rejection: %',statement; end $$;
select pg_temp.ok((select bool_and(snapshot=workflow_snapshot(id)) from fixture_old_snapshots),'pre-migration source fingerprints unchanged');
insert into schedule_assignments(id,project_id,start_date,end_date,start_time,end_time,note)
values ('00000000-0000-0000-0000-000000001201','00000000-0000-0000-0000-000000000101','2026-12-01','2026-12-03','06:30','15:00','End time test');
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select pg_temp.denied($q$update schedule_assignments set end_time='06:00' where id='00000000-0000-0000-0000-000000001201'$q$);
select pg_temp.denied($q$update schedule_assignments set start_time=null where id='00000000-0000-0000-0000-000000001201'$q$);
select schedule_remove_day(id,'2026-12-02',updated_at) from schedule_assignments where id='00000000-0000-0000-0000-000000001201';
select pg_temp.ok((select count(*)=2 and bool_and(start_time='06:30' and end_time='15:00') from schedule_assignments where note='End time test'),'day splitting preserves planned hours');
-- Edit and republish a plan that existed before the column was added.
select workflow_save_draft(id,revision,jsonb_set(jsonb_set(draft,'{assignments,0,start_time}','"06:30"'),'{assignments,0,end_time}','"15:00"')) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select pg_temp.denied($q$select workflow_save_draft(id,revision,jsonb_set(draft,'{assignments,0,end_time}','"05:00"')) from workflow_plans where id='00000000-0000-0000-0000-000000000903'$q$);
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000001209',workflow_review_plan(id)->>'review_token',true) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select pg_temp.ok((select start_time='06:30' and end_time='15:00' from schedule_assignments where id='00000000-0000-0000-0000-000000000605'),'old plan accepts and publishes end time');
select workflow_save_draft(id,revision,jsonb_set(draft,'{assignments,0,end_time}','null')) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select workflow_publish_plan(id,revision,'00000000-0000-0000-0000-000000001210',workflow_review_plan(id)->>'review_token',true) from workflow_plans where id='00000000-0000-0000-0000-000000000903';
select pg_temp.ok((select end_time is null from schedule_assignments where id='00000000-0000-0000-0000-000000000605'),'end time can be cleared');
reset role;

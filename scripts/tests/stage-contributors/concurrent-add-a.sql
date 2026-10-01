begin;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select record_stage_contributors('00000000-0000-4000-8000-000000000200',jsonb_build_object(
 'opening_id','00000000-0000-4000-8000-000000000020','stage','Flashing','work_date',current_date-1,'outcome','finished',
 'people',jsonb_build_array('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003')));
select pg_sleep(5);
commit;

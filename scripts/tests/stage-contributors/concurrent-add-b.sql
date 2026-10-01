begin;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000007',true);
select record_stage_contributors('00000000-0000-4000-8000-000000000201',jsonb_build_object(
 'opening_id','00000000-0000-4000-8000-000000000020','stage','Flashing','work_date',current_date-1,'outcome','finished',
 'people',jsonb_build_array('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004')));
commit;

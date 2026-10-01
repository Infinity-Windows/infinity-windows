begin;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select correct_stage_contributors('00000000-0000-4000-8000-000000000202',jsonb_build_object(
 'unit_id',:'unit','stage','Flashing','work_date',current_date-1,'expected_digest',:'digest','reason','First correction',
 'remove',jsonb_build_array('00000000-0000-4000-8000-000000000002')));
select pg_sleep(5);
commit;

begin;
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000007',true);
select correct_stage_contributors('00000000-0000-4000-8000-000000000203',jsonb_build_object(
 'unit_id',:'unit','stage','Flashing','work_date',current_date-1,'expected_digest',:'digest','reason','Stale competing correction',
 'remove',jsonb_build_array('00000000-0000-4000-8000-000000000004')));
commit;

-- Disposable historical fixture: run the original pre0841 keyed clock function.
-- No retained receipt table or new request-version ledger exists at this point.
insert into auth.users(id) values('00000000-0000-4000-8000-000000580001');
insert into profiles(id,display_name,role,is_test) values('00000000-0000-4000-8000-000000580001','Pre-retained clock fixture','owner',false);
insert into projects(id,job_code,name) values('00000000-0000-4000-8000-000000580010','PRE-RETAINED-CLOCK','Synthetic historical source');
insert into toolbox_completions(profile_id,signed_at,typed_name) values('00000000-0000-4000-8000-000000580001',clock_timestamp(),'Synthetic');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000580001',false);
set role authenticated;
select clock_in('00000000-0000-4000-8000-000000580010'::uuid,null::uuid,null::text,null::double precision,null::double precision,null::text,null::text,'00000000-0000-4000-8000-000000580100'::uuid,clock_timestamp()-interval '3 hours',clock_timestamp(),0);
reset role;
select set_config('request.jwt.claim.sub','',false);

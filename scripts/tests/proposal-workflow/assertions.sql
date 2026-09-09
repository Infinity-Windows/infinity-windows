insert into profiles(id,role,is_partner) values
 ('11111111-1111-4111-8111-111111111111','owner',false),
 ('22222222-2222-4222-8222-222222222222','supervisor',false),
 ('33333333-3333-4333-8333-333333333333','foreman',false),
 ('44444444-4444-4444-8444-444444444444','owner',true),
 ('55555555-5555-4555-8555-555555555555','installer',false);
grant usage on schema public,auth,storage to authenticated;
grant select,insert on storage.objects to authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
select public.proposal_write('create','{"name":"Test job","contractor":"STG"}') as created \gset
reset role;
select id as job from proposal_jobs limit 1 \gset
-- All tests below run as actual client role, not superuser bypass.
select set_config('test.job',:'job',false);
set role authenticated;
do $$ begin
 begin perform public.proposal_write('stage',jsonb_build_object('job_id',current_setting('test.job'),'version',1,'stage','approved'));raise exception 'TEST failed: approval bypass';exception when others then if sqlerrm='TEST failed: approval bypass' then raise; end if;end;
 begin perform public.proposal_write('stage',jsonb_build_object('job_id',current_setting('test.job'),'version',999,'stage','drafting'));raise exception 'TEST failed: stale edit';exception when others then if sqlerrm='TEST failed: stale edit' then raise; end if;end;
 perform public.proposal_write('bid',jsonb_build_object('job_id',current_setting('test.job'),'version',1,'number','P1','contractor','STG','amount',500,'scope','Install','submitted_at',now()-interval '4 days'));
 if (select follow_up_on from proposal_jobs limit 1)<>(now() at time zone 'America/Denver')::date then raise exception 'TEST failed: follow-up clock';end if;
 perform public.proposal_write('stage',jsonb_build_object('job_id',current_setting('test.job'),'version',2,'stage','submitted'));
 perform public.proposal_write('bid',jsonb_build_object('job_id',current_setting('test.job'),'version',3,'number','P1','contractor','STG','amount',600));
 if (select count(*) from proposal_bids)<>2 then raise exception 'TEST failed: revision lost';end if;
 if (select amount from proposal_bids where revision=1)<>500 then raise exception 'TEST failed: old price changed';end if;
 begin update proposal_bids set amount=1;raise exception 'TEST failed: direct bid edit';exception when insufficient_privilege then null;end;
 perform public.proposal_write('file',jsonb_build_object('job_id',current_setting('test.job'),'version',4,'id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','filename','signed.pdf','kind','signed_agreement','bytes',10));
 begin perform public.proposal_write('file_ready',jsonb_build_object('job_id',current_setting('test.job'),'version',5,'id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));raise exception 'TEST failed: missing bytes accepted';exception when others then if sqlerrm='TEST failed: missing bytes accepted' then raise;end if;end;
end $$;
insert into storage.objects(bucket_id,name) values('proposal-files',current_setting('test.job')||'/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
select public.proposal_write('file_ready',jsonb_build_object('job_id',current_setting('test.job'),'version',5,'id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
select public.proposal_write('accept',jsonb_build_object('job_id',current_setting('test.job'),'version',6,'bid_id',(select id from proposal_bids where revision=1),'signed_document_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','accepted_amount',300,'accepted_scope','Phase A only','acceptance_email','Contractor confirms phase A'));
select public.proposal_write('stage',jsonb_build_object('job_id',current_setting('test.job'),'version',7,'stage','approved'));
do $$ begin
 begin perform public.proposal_write('stage',jsonb_build_object('job_id',current_setting('test.job'),'version',8,'stage','scheduled'));raise exception 'TEST failed: unconfirmed schedule';exception when others then if sqlerrm='TEST failed: unconfirmed schedule' then raise;end if;end;
 if (select count(*) from storage.objects where bucket_id='proposal-files')<>1 then raise exception 'TEST failed: owner cannot read file';end if;
end $$;
reset role;
-- Partner claiming an owner role still has no table, RPC or file access.
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
set role authenticated;
do $$ begin
 if exists(select 1 from proposal_jobs) or exists(select 1 from proposal_bids) or exists(select 1 from proposal_activity) or exists(select 1 from storage.objects) then raise exception 'TEST failed: partner data leak';end if;
 begin perform public.proposal_write('create','{"name":"hack"}');raise exception 'TEST failed: partner write';exception when insufficient_privilege then null;end;
 begin insert into storage.objects(bucket_id,name) values('proposal-files','hack');raise exception 'TEST failed: partner storage write';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
set role authenticated;
do $$ begin
 if exists(select 1 from proposal_jobs) or exists(select 1 from storage.objects) then raise exception 'TEST failed: foreman data leak';end if;
 begin perform public.proposal_write('create','{"name":"hack"}');raise exception 'TEST failed: foreman write';exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
set role authenticated;
do $$ begin
 if exists(select 1 from proposal_jobs) then raise exception 'TEST failed: installer read';end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
set role authenticated;
do $$ begin if (select count(*) from proposal_jobs)<>1 then raise exception 'TEST failed: supervisor access';end if;end $$;

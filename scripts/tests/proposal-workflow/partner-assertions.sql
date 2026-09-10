reset role;
select id as job from proposal_jobs order by created_at limit 1 \gset
select set_config('test.job',:'job',false);
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
update proposal_jobs set notes='INTERNAL SECRET',start_precision='date',target_start='2026-12-01' where id=:'job';
set role authenticated;
select proposal_share(id,version,'partner@example.test',array(select id from proposal_bids where job_id=proposal_jobs.id and revision=1),array['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']::uuid[]) from proposal_jobs where id=current_setting('test.job')::uuid;
reset role;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
set role authenticated;
do $$ declare payload jsonb;begin
 payload:=public.stg_workflow();
 if jsonb_array_length(payload)<>1 then raise exception 'TEST failed: shared job missing';end if;
 if payload::text like '%INTERNAL SECRET%' or (payload->0) ? 'notes' then raise exception 'TEST failed: internal notes leak';end if;
 if jsonb_array_length(payload->0->'bids')<>1 then raise exception 'TEST failed: unshared revision leaked';end if;
 if exists(select 1 from proposal_jobs) or exists(select 1 from proposal_partner_shares) then raise exception 'TEST failed: direct partner reads';end if;
 if not public.proposal_partner_file(current_setting('test.job')||'/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then raise exception 'TEST failed: shared file unavailable';end if;
 if public.proposal_partner_file('unshared') then raise exception 'TEST failed: arbitrary file';end if;
 perform public.stg_workflow_reply(current_setting('test.job')::uuid,(payload->0->>'version')::integer,'December 1 works',true);
 begin perform public.stg_workflow_reply(current_setting('test.job')::uuid,(payload->0->>'version')::integer,'stale',true);raise exception 'TEST failed: stale approval';exception when others then if sqlerrm='TEST failed: stale approval' then raise;end if;end;
 begin perform public.proposal_share(current_setting('test.job')::uuid,1,'partner@example.test','{}','{}');raise exception 'TEST failed: partner sharing';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$ begin if (select confirmed_start from proposal_jobs where id=current_setting('test.job')::uuid)<>'2026-12-01'::date then raise exception 'TEST failed: approval not saved';end if;end $$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
set role authenticated;
select proposal_share(id,version,'partner@example.test','{}','{}',true) from proposal_jobs where id=current_setting('test.job')::uuid;
reset role;
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
set role authenticated;
do $$ begin
 if public.stg_workflow()<>'[]'::jsonb or public.proposal_partner_file(current_setting('test.job')||'/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then raise exception 'TEST failed: revoked access retained';end if;
 begin perform public.stg_workflow_reply(current_setting('test.job')::uuid,1,'revoked',false);raise exception 'TEST failed: revoked reply';exception when insufficient_privilege then null;end;
end $$;
reset role;

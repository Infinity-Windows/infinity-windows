-- One phone pressing Save. Holds its transaction open after the write so the
-- other sessions started beside it have to wait on the same job-day.
\o /dev/null
insert into race_starts(tag) values (:'tag');
begin;
select set_config('request.jwt.claim.sub', :'actor', true);
set local role authenticated;
insert into race_results(tag, result) select :'tag', race_try(:'cid'::uuid, :'claimed'::uuid, :'job'::uuid, :'words');
select pg_sleep(1);
commit;

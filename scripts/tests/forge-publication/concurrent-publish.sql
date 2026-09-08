set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
select workflow_publish_plan('00000000-0000-0000-0000-000000000903',1,'00000000-0000-0000-0000-000000000916',(select token from fixture_review_token));

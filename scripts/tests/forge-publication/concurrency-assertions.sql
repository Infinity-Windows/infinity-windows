do $$ begin
 if (select count(*) from workflow_plan_revisions where plan_id='00000000-0000-0000-0000-000000000903')<>1
 or (select count(*) from workflow_notice_outbox where plan_id='00000000-0000-0000-0000-000000000903')<>1
 or (select count(*) from schedule_events where assignment_id='00000000-0000-0000-0000-000000000605' and kind='published')<>1
 then raise exception 'Concurrent retry duplicated publication'; end if;
 if (public.person_record_counts('00000000-0000-0000-0000-000000000004')->>'workflow_plans.created_by')::int<>3
 or (public.person_record_counts('00000000-0000-0000-0000-000000000004')->>'workflow_plan_revisions.actor')::int<>5
 then raise exception 'Account removal failed to preserve plan history'; end if;
end $$;

do $$ declare t text; now_rows jsonb; begin
 if (select count(*) from custom_work_units where opening_id='00000000-0000-4000-8000-000000000020')<>1 then raise exception 'Concurrent opening requests created duplicate units'; end if;
 if (select count(*) from crew_work_records where stage='Flashing')<>2 then raise exception 'Expected two distinct overlapping reports'; end if;
 if (select count(*) from crew_work_record_people where voided_at is null)<>2 then raise exception 'Expected one correction and two remaining contributors'; end if;
 if (select count(*) from crew_work_record_people where voided_at is not null)<>1 then raise exception 'A stale correction changed evidence'; end if;
 if exists(select 1 from custom_work_commands where id='00000000-0000-4000-8000-000000000203') then raise exception 'Stale correction left a receipt'; end if;
 if (select count(*) from custom_work_history where action='stage_contributor_correction')<>1 then raise exception 'Stale correction left history'; end if;
 if exists(select 1 from crew_work_records where whole_complete) then raise exception 'Stage attribution completed installation'; end if;
 foreach t in array array['profiles','time_shifts','custom_work_sessions','unit_sessions','task_sessions','opening_phases','points_ledger','project_openings','opening_assignment_events'] loop
  execute format('select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),''[]''::jsonb) from public.%I x',t) into now_rows;
  if now_rows is distinct from (select rows from fixture_preserved where table_name=t) then raise exception 'Preserved % values changed',t; end if;
 end loop;
 if (select to_jsonb(u) from custom_work_units u where id='00000000-0000-4000-8000-000000000040') is distinct from (select rows from fixture_preserved where table_name='saved_unit') then raise exception 'Existing timed unit facts or revision changed'; end if;
 raise notice 'Concurrent add/correction and nonzero full-row preservation assertions passed';
end $$;

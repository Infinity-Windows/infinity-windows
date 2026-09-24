do $$
declare n int;
begin
  -- The sessions really overlapped: every one began while the first save still
  -- held its transaction open (each holds it for a second).
  select count(*) into n from race_starts;
  if n <> 9 then raise exception '% sessions started', n; end if;
  if (select max(started_at) - min(started_at) from race_starts) >= interval '1 second' then
    raise exception 'sessions did not overlap; the race was not exercised';
  end if;
  -- Same id pressed four times at once: one entry, the rest get its receipt.
  select count(*) into n from daily_log_contributions where id = '00000000-0000-4000-8000-000000001001';
  if n <> 1 then raise exception 'same-id race saved % entries', n; end if;
  select count(*) into n from race_results where tag like 'same-%' and result->>'status' = 'saved';
  if n <> 1 then raise exception 'same-id race: % saved receipts', n; end if;
  select count(*) into n from race_results where tag like 'same-%' and result->>'status' = 'already_saved'
    and result->>'contribution_id' = '00000000-0000-4000-8000-000000001001';
  if n <> 3 then raise exception 'same-id race: % replayed receipts', n; end if;
  select count(*) into n from daily_logs where project_id = '00000000-0000-4000-8000-000000000090';
  if n <> 1 then raise exception 'same-id race made % logs', n; end if;
  select (length(notes) - length(replace(notes, 'Added by', ''))) / length('Added by') into n
    from daily_logs where project_id = '00000000-0000-4000-8000-000000000090';
  if n <> 1 then raise exception 'same-id race appended % times', n; end if;

  -- The account that pressed Save is not the signed-in caller: refused, and
  -- nothing under that id or in those words exists anywhere.
  select count(*) into n from race_results where tag = 'wrong-actor' and result->>'status' = 'refused' and result->>'code' = '42501';
  if n <> 1 then raise exception 'wrong actor was not refused'; end if;
  select count(*) into n from daily_log_contributions where id = '00000000-0000-4000-8000-000000003001';
  if n <> 0 then raise exception 'wrong actor saved an entry'; end if;
  select count(*) into n from daily_logs where notes like '%under Ben%';
  if n <> 0 then raise exception 'wrong actor words reached a log'; end if;

  -- Four people previewing the same empty job-day: one saves, three are stale
  -- with nothing written, and nobody's words are replaced.
  select count(*) into n from race_results where tag like 'people-%' and result->>'status' = 'saved';
  if n <> 1 then raise exception 'people race: % saved', n; end if;
  select count(*) into n from race_results where tag like 'people-%' and result->>'status' = 'stale'
    and (result->>'current_revision')::int = 1;
  if n <> 3 then raise exception 'people race: % stale', n; end if;
  select count(*) into n from daily_log_contributions where project_id = '00000000-0000-4000-8000-000000000091';
  if n <> 1 then raise exception 'people race: % entries', n; end if;
  select count(*) into n from daily_logs where project_id = '00000000-0000-4000-8000-000000000091' and revision = 1;
  if n <> 1 then raise exception 'people race: log revision moved'; end if;
end $$;
select 'ok' as ai_daily_log_concurrency;

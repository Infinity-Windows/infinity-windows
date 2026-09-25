-- Synthetic people and jobs for the concurrent checks.
insert into profiles(id, role, display_name) values
  ('00000000-0000-4000-8000-000000000001','installer','Ana'),
  ('00000000-0000-4000-8000-000000000002','foreman','Frank'),
  ('00000000-0000-4000-8000-000000000003','installer','Ben'),
  ('00000000-0000-4000-8000-000000000004','supervisor','Sam');
insert into auth.users(id, email) select id, lower(display_name) || '@example.test' from profiles;
insert into projects(id, name) values
  ('00000000-0000-4000-8000-000000000090','Synthetic A'),
  ('00000000-0000-4000-8000-000000000091','Synthetic B');
create table race_results(tag text, result jsonb);
create table race_starts(tag text, started_at timestamptz not null default clock_timestamp());
grant insert, select on race_results to authenticated;
-- One Save as the phone sends it: the signed-in session (request.jwt) plus the
-- account the phone says pressed Save. A refusal is recorded, not raised, so a
-- refused session still reports.
create function race_try(p_cid uuid, p_claimed uuid, p_job uuid, p_words text) returns jsonb
language plpgsql as $$
begin
  return append_daily_log_contribution(p_cid, p_claimed, p_job, current_date - 1, 0,
    jsonb_build_object('work_completed', jsonb_build_object('status','captured','value', p_words)), p_words, '{}', '{}');
exception when others then
  return jsonb_build_object('status', 'refused', 'code', sqlstate);
end $$;
grant execute on function race_try(uuid, uuid, uuid, text) to authenticated;

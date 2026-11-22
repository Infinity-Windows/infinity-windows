-- The Workday release's crew announcements (20261130230000_workday_release_notes.sql).
-- QA profiles only, no business job writes; the harness always rolls this back.
do $$
declare
  person uuid;
  original text;
  role_name text;
  seen integer;
  before jsonb;
begin
  perform pg_temp.dry_run_as_system();
  person := pg_temp.dry_run_pick('foreman');
  select role into original from public.profiles where id = person and is_test is true;
  if original is null then
    raise exception 'dry run: refuses a profile that is not a QA profile';
  end if;
  select jsonb_agg(to_jsonb(n) order by n.id) into before from public.app_release_notes n
    where n.id in ('2026-11-22-new-look-workday', '2026-11-22-plan-and-activities');
  perform pg_temp.dry_run_check('both notes are published today in both languages',
    jsonb_array_length(before) = 2
    and before->0->>'published_on' = '2026-11-22' and before->1->>'published_on' = '2026-11-22'
    and before->0->>'body_es' like '%Mi jornada%' and before->1->>'body_es' like '%Actividades recientes%');

  foreach role_name in array array['installer', 'foreman', 'supervisor', 'owner'] loop
    perform pg_temp.dry_run_as_system();
    update public.profiles set role = role_name where id = person and is_test is true;
    perform pg_temp.dry_run_act_as(person);
    select count(*) into seen from public.app_release_notes
      where id in ('2026-11-22-new-look-workday', '2026-11-22-plan-and-activities');
    -- An installer is told about the Workday only; the Plan note is for foremen and above.
    perform pg_temp.dry_run_check(role_name || ' sees the notes meant for them',
      seen = case when role_name = 'installer' then 1 else 2 end, seen::text);
  end loop;

  perform pg_temp.dry_run_as_system();
  update public.profiles set role = original where id = person and is_test is true;
  perform pg_temp.dry_run_check('the QA profile has its own role back',
    (select role = original from public.profiles where id = person));
end $$;

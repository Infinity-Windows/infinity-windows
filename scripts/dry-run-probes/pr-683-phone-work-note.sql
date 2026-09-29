-- PR #683 only adds a role-scoped release note. Check the exact row after
-- applying the migration; the harness rolls the whole run back.
do $$
declare
  v_count integer;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count
  from public.app_release_notes
  where id = '2026-09-29-phone-work-unit-plan'
    and published_on = date '2026-09-29'
    and audience = array[0,1,2,3]
    and kind = 'improvement'
    and title_en = 'Add a unit from Work'
    and title_es = 'Agregar una unidad desde Trabajo';
  perform pg_temp.dry_run_check(
    'phone Work release note is present for all crew roles',
    v_count = 1,
    v_count || ' row(s)'
  );
end $$;

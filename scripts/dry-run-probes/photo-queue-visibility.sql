-- Release note only; prove the row passes live constraints and rollback.
do $$
declare
  v_count integer;
begin
  perform pg_temp.dry_run_as_system();
  select count(*) into v_count
  from public.app_release_notes
  where id = '2026-09-29-install-photo-queue-visibility'
    and published_on = date '2026-09-29'
    and audience = array[0,1,2,3]
    and kind = 'fix'
    and title_en = 'See photos waiting to send';
  perform pg_temp.dry_run_check(
    'photo-queue visibility note is present for all crew roles',
    v_count = 1,
    v_count || ' row(s)'
  );
end $$;

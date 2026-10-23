-- Application stale-save conflicts are permanent for the submitted snapshot.
-- PostgREST 14 retries SQLSTATE 40001 indefinitely; use HTTP 409 instead.
-- Preserve the deployed bodies, signatures, locks, permission checks, grants,
-- SECURITY DEFINER settings and all revision/digest/snapshot predicates.
-- Historical migrations stay unchanged. Only these audited RPCs are patched.
do $migration$
declare
  fn record;
  definition text;
  patched text;
  seen integer := 0;
  names text[] := array[]::text[];
begin
  for fn in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in (
        'set_project_location', 'file_daily_log', 'correct_stage_contributors',
        'workflow_save_draft', 'workflow_publish_plan'
      )
  loop
    seen := seen + 1;
    names := array_append(names, fn.proname);
    definition := pg_get_functiondef(fn.oid);
    patched := regexp_replace(definition,
      $pattern$errcode[[:space:]]*=[[:space:]]*'40001'$pattern$,
      $replacement$errcode = 'PT409'$replacement$, 'gi');
    if patched <> definition then
      execute patched;
    elsif definition !~ $pattern$'PT409'$pattern$ then
      raise exception 'Conflict RPC % has an unexpected definition; review before applying', fn.proname;
    end if;
  end loop;
  -- Fail closed if the installed schema differs from this audited function set.
  if seen <> 5 or (select count(distinct name) from unnest(names) as name) <> 5 then
    raise exception 'Expected five conflict RPCs, found %; review installed schema', seen;
  end if;
end;
$migration$;

-- Schedule weekly tip synthesis via pg_cron when available.
-- Falls back to manual invoke of synthesize-type-tips Edge Function.

do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
exception
  when others then
    raise notice 'pg_cron not available — invoke synthesize-type-tips manually or via dashboard cron';
end;
$$;

do $$
declare
  v_url text;
  v_key text;
begin
  begin
    v_url := current_setting('app.settings.edge_functions_url', true);
    v_key := current_setting('app.settings.service_role_key', true);
  exception when others then
    return;
  end;

  if v_url is null or v_url = '' or v_key is null or v_key = '' then
    raise notice 'Set app.settings.edge_functions_url + service_role_key to enable cron tip synthesis';
    return;
  end if;

  perform cron.unschedule('synthesize-type-tips-weekly');
exception
  when others then null;
end;
$$;

-- Cron job body is only registered when settings exist; otherwise operators
-- schedule it in the Supabase dashboard pointing at /functions/v1/synthesize-type-tips.
do $$
declare
  v_url text;
  v_key text;
begin
  begin
    v_url := current_setting('app.settings.edge_functions_url', true);
    v_key := current_setting('app.settings.service_role_key', true);
  exception when others then
    return;
  end;
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    return;
  end if;

  perform cron.schedule(
    'synthesize-type-tips-weekly',
    '0 12 * * 1',
    format(
      $cron$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{"min_installs":3}'::jsonb
      );
      $cron$,
      rtrim(v_url, '/') || '/synthesize-type-tips',
      v_key
    )
  );
exception
  when others then
    raise notice 'Could not schedule tip synthesis cron: %', sqlerrm;
end;
$$;

-- Phase 3: webhook hooks for vault autofile + weekly report scheduling.

create or replace function notify_vault_autofile()
returns trigger
language plpgsql
security definer
as $$
declare
  v_url text;
  v_key text;
begin
  begin
    v_url := current_setting('app.settings.edge_functions_url', true);
    v_key := current_setting('app.settings.service_role_key', true);
  exception when others then
    return new;
  end;

  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    return new;
  end if;

  begin
    perform net.http_post(
      url := rtrim(v_url, '/') || '/vault-autofile',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'install_events',
        'record', row_to_json(new)
      )
    );
  exception when others then
    raise notice 'vault autofile notify failed: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists install_events_vault_autofile on install_events;
create trigger install_events_vault_autofile
  after insert on install_events
  for each row
  execute function notify_vault_autofile();

-- Weekly report cron (Mondays 13:00 UTC) when settings are present.
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
    raise notice 'Set app.settings.edge_functions_url + service_role_key to enable weekly report cron';
    return;
  end if;

  begin
    perform cron.unschedule('weekly-warehouse-report');
  exception when others then null;
  end;

  perform cron.schedule(
    'weekly-warehouse-report',
    '0 13 * * 1',
    format(
      $cron$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb
      );
      $cron$,
      rtrim(v_url, '/') || '/weekly-report',
      v_key
    )
  );
exception
  when others then
    raise notice 'Could not schedule weekly report cron: %', sqlerrm;
end;
$$;

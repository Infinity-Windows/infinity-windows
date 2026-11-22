-- Workday can time another activity on an already completed installation.
-- Keep the existing clock/session validations and the legacy visit behavior.
do $$
declare
  definition text := pg_get_functiondef('public.custom_work_command(uuid,text,jsonb)'::regprocedure);
  reopen_condition text := 'where id=target and facts->>''installation_complete''=''Yes'';';
  changed_condition text := 'where id=target and facts->>''installation_complete''=''Yes''
        and (p_data->''preserve_unit_completion'') is distinct from ''true''::jsonb;';
begin
  if (length(definition) - length(replace(definition, reopen_condition, ''))) <> length(reopen_condition) then
    raise exception 'Expected exactly one custom work unit reopen condition';
  end if;
  execute replace(definition, reopen_condition, changed_condition);
end;
$$;

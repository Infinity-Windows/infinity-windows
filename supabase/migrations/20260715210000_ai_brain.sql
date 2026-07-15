-- Phase 2: AI brain columns + transcription hooks.
-- OPENAI_API_KEY lives only as an Edge Function secret (never in git/client).

alter table window_types
  add column if not exists tips_json jsonb not null default '[]'::jsonb,
  add column if not exists watch_outs_json jsonb not null default '[]'::jsonb,
  add column if not exists outcome_difficulty int
    check (outcome_difficulty is null or outcome_difficulty between 1 and 5),
  add column if not exists tips_synthesized_at timestamptz,
  add column if not exists tips_install_count int not null default 0;

comment on column window_types.tips_json is
  'Synthesized top tips from install memos (human-editable; regenerate additively).';
comment on column window_types.watch_outs_json is
  'Synthesized watch-outs / pitfalls from install memos.';
comment on column window_types.outcome_difficulty is
  'Difficulty derived from grades/times (overrides gut-feel catalog rating in UI when set).';

-- Queue flag so a webhook/Edge Function can pick up untranscribed voice memos.
alter table attachments
  add column if not exists transcribed_at timestamptz;

create index if not exists attachments_voice_pending_idx
  on attachments (created_at)
  where kind = 'voice_memo' and transcribed_at is null;

-- Optional: enable pg_net for DB→Edge Function webhooks when available.
-- Configure Database Webhook in Supabase dashboard if pg_net is unavailable:
--   table attachments INSERT → POST /functions/v1/transcribe-install-memo
do $$
begin
  create extension if not exists pg_net with schema extensions;
exception
  when others then
    raise notice 'pg_net not available — configure a Database Webhook for attachments instead';
end;
$$;

-- Helper: invoke transcribe Edge Function for a new voice attachment.
-- Requires app.settings.edge_functions_url + service role in vault, or rely on
-- dashboard Database Webhooks. Safe no-op when unset.
create or replace function notify_transcribe_install_memo()
returns trigger
language plpgsql
security definer
as $$
declare
  v_url text;
  v_key text;
begin
  if new.kind is distinct from 'voice_memo' then
    return new;
  end if;
  if new.install_event_id is null then
    return new;
  end if;

  begin
    v_url := current_setting('app.settings.edge_functions_url', true);
    v_key := current_setting('app.settings.service_role_key', true);
  exception when others then
    return new;
  end;

  if v_url is null or v_url = '' or v_key is null or v_key = '' then
    return new;
  end if;

  begin
    perform net.http_post(
      url := rtrim(v_url, '/') || '/transcribe-install-memo',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object(
        'type', 'INSERT',
        'table', 'attachments',
        'record', row_to_json(new)
      )
    );
  exception when others then
    raise notice 'transcribe notify failed: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists attachments_notify_transcribe on attachments;
create trigger attachments_notify_transcribe
  after insert on attachments
  for each row
  execute function notify_transcribe_install_memo();

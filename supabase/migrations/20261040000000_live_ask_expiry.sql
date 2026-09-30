-- The phone closes Live Ask at three minutes, but a suspended browser cannot
-- be trusted to run its timer. Keep a server-owned record of provider sessions
-- and hang up anything still open once its deadline has passed.
create table public.live_ask_provider_sessions (
  id text primary key check (length(id) between 5 and 160),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index live_ask_provider_sessions_due on public.live_ask_provider_sessions(expires_at)
  where closed_at is null;
alter table public.live_ask_provider_sessions enable row level security;
revoke all on public.live_ask_provider_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.live_ask_provider_sessions to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin
  perform cron.unschedule('live-ask-expiry');
exception when others then null;
end $$;
-- Parameterless, due-only sweep. The Edge function accepts no caller data,
-- reads only service-role rows and sends hangup for expired provider sessions.
select cron.schedule(
  'live-ask-expiry', '* * * * *',
  $c$select net.http_post(
    url := 'https://czprjcskmzzagdztqonm.supabase.co/functions/v1/live-ask-expiry',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json"}'::jsonb
  );$c$
);

-- Forge AI daily logs: a person's reviewed contribution is ADDED to the one
-- shared job-day log, once, and never replaces what anybody else wrote.
--
-- WHY A SECOND WRITER. file_daily_log (20261014000000) upserts the whole row:
-- the last save's notes, day flow, weather and reflections replace the last
-- ones. That is right for the manual editor, where the person is looking at the
-- current text while they edit it. It is wrong for a draft built in Ask: the
-- draft is assembled over minutes, the phone can be offline, a lost response is
-- retried, and a second installer may file the same job-day in between. Sent
-- through file_daily_log, any of those silently deletes someone's words.
--
-- The laws this file keeps (.scratch/ai-daily-logs/task.md):
--  * The model never writes. Only append_daily_log_contribution, called by the
--    person's own Save, does — for the exact words they previewed.
--  * The caller is auth.uid(): an internal crew role, not a partner, not
--    retired, access not removed; a test login only reaches the sandbox.
--  * Exact revision: the Save names the revision of the shared log the person
--    was shown (0 = there was none). Anything else is `stale`, and NOTHING is
--    written — the phone shows the new text and the person saves again.
--  * Append once: the contribution id is minted on the phone when the draft
--    starts and is the idempotency key. The same words sent again (a double tap,
--    a retry after a lost response, even after the log has moved on) return the
--    receipt that was saved; different words under a used id are refused.
--  * Attribution: the shared row keeps its first author (filed_by); the addendum
--    carries a header naming who added it; the contribution row keeps the actor
--    and server time.
--  * Photos are linked by their stable upload id (attachments.client_id). A
--    photo counts as part of this log only when its row is on the SAME job and
--    was uploaded by the SAME account; a photo already linked elsewhere is
--    refused. No URLs are stored; the bytes stay in install-media.
--  * The phone names the account that pressed Save (p_actor). It must be the
--    signed-in caller: a phone that changed sign-in between the tap and the
--    request is refused before anything is read (the same rule as the learning
--    review's p_actor).
--  * Evidence: every Ask message (ai_field_requests) whose answers went into
--    the entry is listed in source_request_ids, in order. Each must be the
--    actor's own message from one Ask conversation.
begin;

-- ---------------------------------------------------------------------------
-- 1. The shared log's revision
-- ---------------------------------------------------------------------------
-- Every change to what the log SAYS bumps it, from any writer (file_daily_log,
-- this file, a support fix in SQL). Sharing with the builder changes who can
-- read it, not what it says, so it does not make a pending Save stale.
alter table public.daily_logs add column if not exists revision bigint not null default 1;

create or replace function public._daily_log_revision() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if (old.headline, old.notes, old.day_flow, old.reflection, old.weather)
     is distinct from (new.headline, new.notes, new.day_flow, new.reflection, new.weather) then
    new.revision := old.revision + 1;
  else
    -- Nobody sets a revision by hand; an unchanged text keeps its number.
    new.revision := old.revision;
  end if;
  return new;
end $$;
revoke all on function public._daily_log_revision() from public, anon, authenticated;
drop trigger if exists daily_logs_revision on public.daily_logs;
create trigger daily_logs_revision before update on public.daily_logs
  for each row execute function public._daily_log_revision();

-- ---------------------------------------------------------------------------
-- 2. Who may contribute
-- ---------------------------------------------------------------------------
-- can_file_daily_log() is the existing door (internal role, not partner, access
-- not removed). A retired login is also refused here; On site / Off today
-- (profiles.active) is not login access and is not checked.
create or replace function public._daily_log_contributor() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null or public.is_partner_user() or not public.can_file_daily_log()
     or exists (select 1 from profiles where id = uid and retired_at is not null) then
    raise exception 'Daily log entries need a Forge crew login with current access.' using errcode = '42501';
  end if;
  return uid;
end $$;
revoke all on function public._daily_log_contributor() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Contributions and their photos
-- ---------------------------------------------------------------------------
create table if not exists public.daily_log_contributions (
  -- Minted on the phone once per draft: the idempotency key.
  id uuid primary key,
  log_id uuid not null references public.daily_logs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  log_date date not null,
  -- No cascade: a person with a saved contribution is retired, not deleted
  -- (person_record_counts below).
  actor_id uuid not null references public.profiles(id),
  source text not null default 'forge_ai' check (source in ('forge_ai')),
  -- {field: {status: captured|unknown, value?, source?}}; a field that was
  -- never answered is absent, which is how "missing" differs from "unknown".
  answers jsonb not null,
  -- Exactly the body the person previewed, without the attribution header.
  body text not null check (length(btrim(body)) between 1 and 8000),
  content_hash text not null,
  -- The Ask messages the answers came from (ai_field_requests ids), in order.
  source_request_ids uuid[] not null default '{}',
  base_revision bigint not null check (base_revision >= 0),
  saved_revision bigint not null,
  created_log boolean not null,
  created_at timestamptz not null default now()
);
alter table public.daily_log_contributions add column if not exists source_request_ids uuid[] not null default '{}';
create index if not exists daily_log_contributions_log on public.daily_log_contributions(log_id, created_at);
create index if not exists daily_log_contributions_actor on public.daily_log_contributions(actor_id, created_at desc);
create index if not exists daily_log_contributions_job on public.daily_log_contributions(project_id, log_date);

-- One contribution per photo. photo_id is the outbox entry id, which the
-- upload writes as attachments.client_id; the row may arrive later than this.
create table if not exists public.daily_log_contribution_photos (
  photo_id uuid primary key,
  contribution_id uuid not null references public.daily_log_contributions(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists daily_log_contribution_photos_contribution on public.daily_log_contribution_photos(contribution_id);

alter table public.daily_log_contributions enable row level security;
alter table public.daily_log_contribution_photos enable row level security;
revoke all on public.daily_log_contributions from public, anon, authenticated;
revoke all on public.daily_log_contribution_photos from public, anon, authenticated;
grant select on public.daily_log_contributions, public.daily_log_contribution_photos to authenticated;

-- The same readers as the shared log itself (daily_logs_select_crew), minus
-- retired logins. No insert/update/delete policy: the function below is the
-- only writer.
drop policy if exists daily_log_contributions_read on public.daily_log_contributions;
create policy daily_log_contributions_read on public.daily_log_contributions for select to authenticated using (
  not public.is_partner_user() and public.can_file_daily_log()
  and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.retired_at is not null)
);
drop policy if exists daily_log_contribution_photos_read on public.daily_log_contribution_photos;
create policy daily_log_contribution_photos_read on public.daily_log_contribution_photos for select to authenticated using (
  not public.is_partner_user() and public.can_file_daily_log()
  and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.retired_at is not null)
);

-- ---------------------------------------------------------------------------
-- 4. What a receipt says
-- ---------------------------------------------------------------------------
create or replace function public._daily_log_snapshot(p_log public.daily_logs) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_log.id is null then null else jsonb_build_object(
    'id', p_log.id, 'project_id', p_log.project_id, 'log_date', p_log.log_date,
    'revision', p_log.revision, 'headline', p_log.headline, 'notes', p_log.notes,
    'day_flow', p_log.day_flow, 'weather', p_log.weather, 'reflection', p_log.reflection,
    'filed_by', p_log.filed_by, 'filed_by_name', (select display_name from profiles where id = p_log.filed_by),
    'updated_by', p_log.updated_by, 'updated_at', p_log.updated_at, 'created_at', p_log.created_at) end
$$;
revoke all on function public._daily_log_snapshot(public.daily_logs) from public, anon, authenticated;

create or replace function public._daily_log_receipt(p_c public.daily_log_contributions, p_status text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'status', p_status,
    'contribution_id', p_c.id, 'log_id', p_c.log_id, 'project_id', p_c.project_id,
    'log_date', p_c.log_date, 'actor_id', p_c.actor_id,
    'actor_name', (select display_name from profiles where id = p_c.actor_id),
    'base_revision', p_c.base_revision, 'saved_revision', p_c.saved_revision,
    'created_log', p_c.created_log, 'saved_at', p_c.created_at,
    'source_request_ids', to_jsonb(p_c.source_request_ids),
    'photo_ids', coalesce((select jsonb_agg(ph.photo_id order by ph.created_at, ph.photo_id)
      from daily_log_contribution_photos ph where ph.contribution_id = p_c.id), '[]'::jsonb),
    'log', (select public._daily_log_snapshot(l) from daily_logs l where l.id = p_c.log_id))
$$;
revoke all on function public._daily_log_receipt(public.daily_log_contributions, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. The one writer
-- ---------------------------------------------------------------------------
-- The same account on both sides of the request, or nothing happens.
create or replace function public._daily_log_actor(p_actor uuid) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_actor is null or auth.uid() is null or p_actor <> auth.uid() then
    raise exception 'This was started under another sign-in. Nothing was saved.' using errcode = '42501';
  end if;
  return public._daily_log_contributor();
end $$;
revoke all on function public._daily_log_actor(uuid) from public, anon, authenticated;

-- The Ask messages an entry came from, checked: the actor's own, one
-- conversation, none repeated, order kept. A foreign or unknown id refuses the
-- whole save rather than being dropped.
create or replace function public._daily_log_sources(p_actor uuid, p_ids uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare x uuid; conv uuid; first_conv uuid; n int := 0; seen uuid[] := '{}';
begin
  if p_ids is null then return '{}'; end if;
  if cardinality(p_ids) > 50 then raise exception 'An entry can list up to 50 messages.' using errcode = '22023'; end if;
  foreach x in array p_ids loop
    if x is null then raise exception 'A message this entry came from is missing its id.' using errcode = '22023'; end if;
    if x = any(seen) then raise exception 'The same message is listed twice.' using errcode = '22023'; end if;
    select r.conversation_id into conv from ai_field_requests r where r.id = x and r.profile_id = p_actor;
    if not found or conv is null then
      raise exception 'A message this entry came from is not one of yours. Nothing was saved.' using errcode = '22023';
    end if;
    n := n + 1;
    if n = 1 then first_conv := conv;
    elsif conv <> first_conv then
      raise exception 'The messages in one entry must come from the same Ask conversation.' using errcode = '22023';
    end if;
    seen := seen || x;
  end loop;
  return seen;
end $$;
revoke all on function public._daily_log_sources(uuid, uuid[]) from public, anon, authenticated;

-- The first draft of this function had no actor or sources; it was never
-- deployed, but a replay on a database that saw it must not leave it callable.
drop function if exists public.append_daily_log_contribution(uuid, uuid, date, bigint, jsonb, text, uuid[]);

create or replace function public.append_daily_log_contribution(
  p_id uuid,
  p_actor uuid,
  p_project_id uuid,
  p_log_date date,
  p_expected_revision bigint,
  p_answers jsonb,
  p_body text,
  p_photo_ids uuid[] default '{}',
  p_source_request_ids uuid[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid;
  v_name text;
  v_email text;
  v_body text := btrim(coalesce(p_body, ''));
  v_photos uuid[];
  v_sources uuid[];
  v_hash text;
  v_key text;
  v_entry jsonb;
  v_status text;
  v_flow text;
  v_weather text;
  v_reflection jsonb := '{}'::jsonb;
  v_header text;
  v_log daily_logs;
  v_c daily_log_contributions;
  v_base bigint;
begin
  -- Before anything is read: the account that pressed Save is the caller.
  uid := public._daily_log_actor(p_actor);
  if p_id is null then raise exception 'This draft is missing its id. Start the daily log again.' using errcode = '22023'; end if;
  if p_project_id is null or not public._ai_job_visible(p_project_id, uid) then
    raise exception 'Choose an existing job for the daily log.' using errcode = '22023';
  end if;
  if p_log_date is null then raise exception 'A log date is required.' using errcode = '22023'; end if;
  -- The same coarse backstop file_daily_log uses; the phone's local day decides.
  if p_log_date > current_date then raise exception 'The log date cannot be in the future.' using errcode = '22023'; end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'Reload the daily log before saving.' using errcode = '22023';
  end if;
  if length(v_body) = 0 then raise exception 'Say what work was completed before saving.' using errcode = '22023'; end if;
  if length(v_body) > 8000 then raise exception 'This entry is too long. Shorten it and save again.' using errcode = '22023'; end if;

  -- Answers: known fields only, each an object with an explicit status, and a
  -- captured one with nonblank words. Every test is written so an ABSENT key
  -- fails it: in plpgsql a NULL condition is simply "not true", so
  -- `x->>'status' not in (...)` alone would wave a missing status through.
  if p_answers is null or jsonb_typeof(p_answers) is distinct from 'object' or length(p_answers::text) > 40000 then
    raise exception 'This draft could not be read. Start the daily log again.' using errcode = '22023';
  end if;
  for v_key, v_entry in select key, value from jsonb_each(p_answers) loop
    if v_key not in ('work_completed','units_stages','people','problems','notes','day_flow','weather',
                     'went_well','went_poorly','would_have_helped','what_worked') then
      raise exception 'This draft has an answer the daily log does not use.' using errcode = '22023';
    end if;
    v_status := case when jsonb_typeof(v_entry) = 'object' and jsonb_typeof(v_entry->'status') = 'string' then v_entry->>'status' end;
    if v_status is null or v_status not in ('captured','unknown') then
      raise exception 'This draft could not be read. Start the daily log again.' using errcode = '22023';
    end if;
    if v_status = 'captured' and (jsonb_typeof(v_entry->'value') is distinct from 'string'
        or coalesce(btrim(v_entry->>'value'), '') = '') then
      raise exception 'This draft could not be read. Start the daily log again.' using errcode = '22023';
    end if;
  end loop;
  if (p_answers->'work_completed'->>'status') is distinct from 'captured' then
    raise exception 'Say what work was completed before saving.' using errcode = '22023';
  end if;
  if (p_answers->'day_flow'->>'status') = 'captured' then
    v_flow := p_answers->'day_flow'->>'value';
    if v_flow is null or v_flow not in ('smooth','fine','stuck') then
      raise exception 'Day flow must be smooth, fine, or stuck.' using errcode = '22023';
    end if;
  end if;
  if (p_answers->'weather'->>'status') = 'captured' then v_weather := btrim(p_answers->'weather'->>'value'); end if;
  foreach v_key in array array['went_well','went_poorly','would_have_helped','what_worked'] loop
    if (p_answers->v_key->>'status') = 'captured' then
      v_reflection := v_reflection || jsonb_build_object(v_key, btrim(p_answers->v_key->>'value'));
    end if;
  end loop;

  v_sources := public._daily_log_sources(uid, p_source_request_ids);

  select coalesce(array_agg(distinct x order by x), '{}') into v_photos from unnest(coalesce(p_photo_ids, '{}')) x;
  if array_position(v_photos, null) is not null then raise exception 'A photo is missing its id.' using errcode = '22023'; end if;
  if cardinality(v_photos) <> cardinality(coalesce(p_photo_ids, '{}')) then
    raise exception 'The same photo is listed twice.' using errcode = '22023';
  end if;
  if cardinality(v_photos) > 12 then raise exception 'Attach at most 12 photos to one entry.' using errcode = '22023'; end if;

  -- The words, not the revision: a retry after a lost response must match
  -- even though the log has since moved on because of that very save.
  v_hash := md5(jsonb_build_object('project', p_project_id, 'date', p_log_date, 'answers', p_answers,
    'body', v_body, 'photos', to_jsonb(v_photos), 'sources', to_jsonb(v_sources))::text);

  -- Same id first, then the job-day: a double tap serialises on the id, two
  -- people on one job-day serialise on the day, and the order never inverts.
  perform pg_advisory_xact_lock(hashtextextended('daily_log_contribution:' || p_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('daily_log:' || p_project_id::text || ':' || p_log_date::text, 0));

  select * into v_c from daily_log_contributions where id = p_id;
  if found then
    if v_c.actor_id <> uid or v_c.content_hash <> v_hash then
      raise exception 'This entry was already saved with different words. Start a new daily log entry.' using errcode = '22023';
    end if;
    return public._daily_log_receipt(v_c, 'already_saved');
  end if;

  select * into v_log from daily_logs where project_id = p_project_id and log_date = p_log_date for update;
  v_base := coalesce(v_log.revision, 0);
  if v_base <> p_expected_revision then
    -- Nothing is written. The phone shows what the log says now.
    return jsonb_build_object('status', 'stale', 'expected_revision', p_expected_revision,
      'current_revision', v_base, 'log', public._daily_log_snapshot(v_log));
  end if;

  -- Photos: never linked twice; an uploaded row must be this job's and this
  -- account's. A row that has not arrived yet is checked when it is read.
  if exists (select 1 from daily_log_contribution_photos where photo_id = any(v_photos)) then
    raise exception 'A photo in this entry is already part of another daily log entry.' using errcode = '22023';
  end if;
  select email into v_email from auth.users where id = uid;
  if exists (select 1 from attachments a where a.client_id = any(v_photos)
             and (a.project_id is distinct from p_project_id or lower(coalesce(a.created_by, '')) <> lower(coalesce(v_email, '')))) then
    raise exception 'A photo in this entry belongs to a different job or person. Remove it and save again.' using errcode = '22023';
  end if;

  select display_name into v_name from profiles where id = uid;
  v_header := 'Added by ' || coalesce(nullif(btrim(v_name), ''), 'a crew member') || ' with Forge AI:';

  if v_log.id is null then
    insert into daily_logs (project_id, log_date, headline, notes, day_flow, reflection, weather, filed_by)
    values (p_project_id, p_log_date, null, v_header || E'\n' || v_body, v_flow,
            nullif(v_reflection, '{}'::jsonb), nullif(v_weather, ''), uid)
    returning * into v_log;
  else
    -- Added, never replaced: optional details fill only what is still empty.
    update daily_logs set
      notes = rtrim(notes) || E'\n\n' || v_header || E'\n' || v_body,
      day_flow = coalesce(day_flow, v_flow),
      weather = coalesce(weather, nullif(v_weather, '')),
      reflection = case when v_reflection = '{}'::jsonb then reflection
                        else nullif(v_reflection || coalesce(reflection, '{}'::jsonb), '{}'::jsonb) end,
      updated_by = uid,
      updated_at = now()
    where id = v_log.id
    returning * into v_log;
  end if;

  insert into daily_log_contributions (id, log_id, project_id, log_date, actor_id, answers, body, content_hash,
    source_request_ids, base_revision, saved_revision, created_log)
  values (p_id, v_log.id, p_project_id, p_log_date, uid, p_answers, v_body, v_hash,
    v_sources, v_base, v_log.revision, v_base = 0)
  returning * into v_c;
  insert into daily_log_contribution_photos (photo_id, contribution_id, project_id)
  select x, p_id, p_project_id from unnest(v_photos) x;

  return public._daily_log_receipt(v_c, 'saved');
end $$;
revoke all on function public.append_daily_log_contribution(uuid, uuid, uuid, date, bigint, jsonb, text, uuid[], uuid[]) from public, anon;
grant execute on function public.append_daily_log_contribution(uuid, uuid, uuid, date, bigint, jsonb, text, uuid[], uuid[]) to authenticated;

-- Which of a contribution's photos have arrived, on the right job, from the
-- person who saved it. The phone's own queue says what is still waiting there;
-- this is the server's half of that answer.
create or replace function public.daily_log_contribution_photo_status(p_contribution uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := public._daily_log_contributor();
  v_c daily_log_contributions;
  v_email text;
begin
  select * into v_c from daily_log_contributions where id = p_contribution;
  if not found or not public._ai_job_visible(v_c.project_id, uid) then return '[]'::jsonb; end if;
  select email into v_email from auth.users where id = v_c.actor_id;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'photo_id', ph.photo_id,
      'arrived', a.id is not null,
      'attachment_id', a.id,
      'storage_path', a.storage_path) order by ph.created_at, ph.photo_id)
    from daily_log_contribution_photos ph
    left join lateral (select at.id, at.storage_path from attachments at
      where at.client_id = ph.photo_id and at.project_id = v_c.project_id
        and lower(coalesce(at.created_by, '')) = lower(coalesce(v_email, '')) limit 1) a on true
    where ph.contribution_id = v_c.id), '[]'::jsonb);
end $$;
revoke all on function public.daily_log_contribution_photo_status(uuid) from public, anon;
grant execute on function public.daily_log_contribution_photo_status(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Registrations: person removal counts, sandbox fence
-- ---------------------------------------------------------------------------
-- The UNION of every restatement on master — 20261026000000 (learning review,
-- which itself carried 20261024000000's field-operations keys and the service,
-- hex-portal, time-off and reminder keys) — plus this file's one line.
-- Migrations apply in name order, so whichever file is last REPLACES the
-- function entirely: a copy taken from one side would silently drop the
-- other's keys and let a person with those records be hard-deleted.
-- app/src/lib/purgeWords.test.ts reads the last definition and fails if the
-- probe list and this object ever disagree.
create or replace function public.person_record_counts(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'hex_learning_reviews.author_id', (select count(*) from hex_learning_reviews where author_id = p_id),
    'hex_learning_reviews.reviewer_id', (select count(*) from hex_learning_reviews where reviewer_id = p_id),
    'hex_learning_reviews.decided_by', (select count(*) from hex_learning_reviews where decided_by = p_id),
    'hex_learning_review_events.actor_id', (select count(*) from hex_learning_review_events where actor_id = p_id),
    'hex_learning_reviews.withdrawn_by', (select count(*) from hex_learning_reviews where withdrawn_by = p_id),
    'hex_learning_deliveries.last_caller', (select count(*) from hex_learning_deliveries where last_caller = p_id),
    'hex_learning_withdrawals.last_caller', (select count(*) from hex_learning_withdrawals where last_caller = p_id),
    'ai_field_requests.profile_id', (select count(*) from ai_field_requests where profile_id = p_id),
    'ai_field_actions.profile_id', (select count(*) from ai_field_actions where profile_id = p_id),
    'daily_log_contributions.actor_id', (select count(*) from daily_log_contributions where actor_id = p_id),
    'crew_work_records.filed_by', (select count(*) from crew_work_records where filed_by = p_id),
    'crew_work_record_people.profile_id', (select count(*) from crew_work_record_people where profile_id = p_id),
 'hex_portal_cases.asker_id',(select count(*) from public.hex_portal_cases where asker_id=p_id),
 'hex_portal_outcomes.actor_id',(select count(*) from public.hex_portal_outcomes where actor_id=p_id),
 'hex_portal_guidance_receipts.actor_id',(select count(*) from public.hex_portal_guidance_receipts where actor_id=p_id),'time_off_requests.profile_id',(select count(*) from time_off_requests where profile_id=p_id),'crew_reminders.profile_id',(select count(*) from crew_reminders where profile_id=p_id)) || jsonb_build_object('service_visits.created_by',(select count(*) from service_visits where created_by=p_id),'service_visit_units.created_by',(select count(*) from service_visit_units where created_by=p_id),'service_time_sessions.profile_id',(select count(*) from service_time_sessions where profile_id=p_id),'service_media.created_by',(select count(*) from service_media where created_by=p_id),'service_audit.actor_id',(select count(*) from service_audit where actor_id=p_id),'service_commands.profile_id',(select count(*) from service_commands where profile_id=p_id)) || jsonb_build_object(
    'custom_work_units.created_by', (select count(*) from custom_work_units where created_by = p_id),
    'custom_work_sessions.profile_id', (select count(*) from custom_work_sessions where profile_id = p_id),
    'custom_work_history.actor_id', (select count(*) from custom_work_history where actor_id = p_id),
    'custom_work_commands.profile_id', (select count(*) from custom_work_commands where profile_id = p_id),

    'workflow_plans.created_by', (select count(*) from workflow_plans where created_by = p_id),
    'workflow_plan_revisions.actor', (select count(*) from workflow_plan_revisions where actor = p_id),
    'workflow_notice_outbox.profile_id', (select count(*) from workflow_notice_outbox where profile_id = p_id),
    -- Time and money.
    'time_shifts.profile_id',
      (select count(*) from time_shifts where profile_id = p_id),
    'unit_sessions.profile_id',
      (select count(*) from unit_sessions where profile_id = p_id),
    'install_events.installer_id',
      (select count(*) from install_events where installer_id = p_id),
    'install_events.credited_to',
      (select count(*) from install_events where credited_to = p_id),
    'receipts.uploaded_by',
      (select count(*) from receipts where uploaded_by = p_id),
    'pay_rates.profile_id',
      (select count(*) from pay_rates where profile_id = p_id),
    'overtime_rules.profile_id',
      (select count(*) from overtime_rules where profile_id = p_id),
    'timecard_periods.profile_id',
      (select count(*) from timecard_periods where profile_id = p_id),
    'time_shift_edits.edited_by',
      (select count(*) from time_shift_edits where edited_by = p_id),
    -- Safety and training.
    'certifications.profile_id',
      (select count(*) from certifications where profile_id = p_id),
    'toolbox_completions.profile_id',
      (select count(*) from toolbox_completions where profile_id = p_id),
    'safety_acks.profile_id',
      (select count(*) from safety_acks where profile_id = p_id),
    'capability_badges.installer_id',
      (select count(*) from capability_badges where installer_id = p_id),
    'installer_clearance.installer_id',
      (select count(*) from installer_clearance where installer_id = p_id),
    'learn_progress.profile_id',
      (select count(*) from learn_progress where profile_id = p_id),
    'learning_video_quiz_attempts.profile_id',
      (select count(*) from learning_video_quiz_attempts where profile_id = p_id),
    'education_credits.profile_id',
      (select count(*) from education_credits where profile_id = p_id),
    -- The job site.
    'daily_logs.filed_by',
      (select count(*) from daily_logs where filed_by = p_id),
    'opening_phases.started_by',
      (select count(*) from opening_phases where started_by = p_id),
    'opening_phases.submitted_by',
      (select count(*) from opening_phases where submitted_by = p_id),
    'flash_run_assignments.assigned_by',
      (select count(*) from flash_run_assignments where assigned_by = p_id),
    'flash_run_assignments.profile_id',
      (select count(*) from flash_run_assignments where profile_id = p_id),
    'summons.requested_by',
      (select count(*) from summons where requested_by = p_id),
    'summon_helpers.profile_id',
      (select count(*) from summon_helpers where profile_id = p_id),
    'summon_declines.profile_id',
      (select count(*) from summon_declines where profile_id = p_id),
    'unit_redos.pressed_by',
      (select count(*) from unit_redos where pressed_by = p_id),
    'schedule_assignment_members.profile_id',
      (select count(*) from schedule_assignment_members where profile_id = p_id),
    'trip_crew.profile_id',
      (select count(*) from trip_crew where profile_id = p_id),
    'vehicle_drivers.profile_id',
      (select count(*) from vehicle_drivers where profile_id = p_id),
    -- What they said and what they were given credit for.
    'points_ledger.profile_id',
      (select count(*) from points_ledger where profile_id = p_id),
    'task_sessions.profile_id',
      (select count(*) from task_sessions where profile_id = p_id),
    'project_messages.author_id',
      (select count(*) from project_messages where author_id = p_id),
    'ask_question_log.asker_id',
      (select count(*) from ask_question_log where asker_id = p_id)
  );
$$;
revoke all on function public.person_record_counts(uuid) from public,anon,authenticated;
grant execute on function public.person_record_counts(uuid) to service_role;

select public.attach_sandbox_guards();
commit;

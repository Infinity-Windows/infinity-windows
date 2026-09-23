-- Ask learning draft, named review and supervisor approval for the Hex-Portal
-- archive (.scratch/ai-learning-review/spec.md, SUPERVISOR-POLICY.md,
-- BRIDGE-CONTRACT.md).
--
-- A crew member writes up what happened on a job (Issue, What happened, Impact,
-- Lesson learned, Preventive action) against an EXISTING Hex-Portal case and
-- sends it to one named foreman, supervisor or owner. A foreman reviews it and
-- asks for changes or forwards it to a named supervisor; only a supervisor or
-- owner (with current access) approves it for the archive. The laws this file keeps:
--  * The case (question, answer, sources) and the field request (words,
--    recording) stay the evidence. Nothing here copies them; a write-up only
--    points at them, and each change to the write-up is a new history row.
--  * A reviewer is an exact profile id somebody tapped, re-checked for role,
--    login access and job visibility at every step. Installers and foremen
--    never approve, not even their own; they send to someone else. A current
--    supervisor or owner may name themselves and explicitly approve their own
--    displayed revision — never automatically, never carried to a new revision.
--  * Every change names the account that pressed the button (p_actor) and the
--    revision its screen showed: a switched sign-in or a stale tab changes nothing,
--    and a retry of the same tap returns what already happened.
--  * Approval is not verification of a construction instruction, and it is not
--    delivery. Delivery is recorded only from the receiver's exact receipt,
--    through a service-only function the edge function calls after checking it.
--  * Withdrawal takes an approved write-up out of every export at once and
--    waits, visibly, for the receiver to confirm removal. Nothing brings it back.
--  * Self-reported impact (minutes, cost) is the author's estimate. It never
--    touches payroll or any clock.
begin;

-- ---------------------------------------------------------------------------
-- 1. Who may take part
-- ---------------------------------------------------------------------------
-- Rank of a person with a current internal login, or null. Role aliases count
-- (role_rank); On site / Off today (profiles.active) does not.
create function public._hex_learning_rank(p_uid uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select public.role_rank(p.role) from profiles p
  where p.id = p_uid and p.role in ('installer','foreman','lead','supervisor','admin','owner','big_boss')
    and not coalesce(p.is_partner, false) and p.retired_at is null and p.access_revoked_at is null
$$;
revoke all on function public._hex_learning_rank(uuid) from public, anon, authenticated;

create function public._hex_learning_caller() returns integer
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r integer;
begin
  if auth.uid() is null or public.is_partner_user() then raise exception 'Current crew access required' using errcode = '42501'; end if;
  r := public._hex_learning_rank(auth.uid());
  if r is null then raise exception 'Current crew access required' using errcode = '42501'; end if;
  return r;
end $$;
revoke all on function public._hex_learning_caller() from public, anon, authenticated;

-- Every change names who pressed it. A phone that signed in as someone else
-- between the tap and the request is refused before anything is read.
create function public._hex_learning_actor(p_actor uuid) returns integer
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_actor is null or auth.uid() is null or p_actor <> auth.uid() then
    raise exception 'This was started under another sign-in. Nothing was changed.' using errcode = '42501';
  end if;
  return public._hex_learning_caller();
end $$;
revoke all on function public._hex_learning_actor(uuid) from public, anon, authenticated;

-- A named reviewer: a foreman, supervisor or owner (aliases included) with a
-- current login, on the same side of the test-login fence, who can see the job.
-- The author qualifies only at supervisor rank or above (parent decision,
-- issues/08): a foreman or installer always needs someone else.
create function public._hex_learning_reviewer_ok(p_reviewer uuid, p_author uuid, p_project uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_reviewer is not null and p_author is not null
    and coalesce(public._hex_learning_rank(p_reviewer) between 1 and 3, false)
    and (p_reviewer <> p_author or public._hex_learning_rank(p_reviewer) >= 2)
    and public.is_test_profile(p_reviewer) = public.is_test_profile(p_author)
    and public._ai_job_visible(p_project, p_reviewer)
$$;
revoke all on function public._hex_learning_reviewer_ok(uuid, uuid, uuid) from public, anon, authenticated;

-- Who may give final approval: the same, at supervisor rank or above.
create function public._hex_learning_approver_ok(p_uid uuid, p_author uuid, p_project uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._hex_learning_reviewer_ok(p_uid, p_author, p_project) and public._hex_learning_rank(p_uid) >= 2
$$;
revoke all on function public._hex_learning_approver_ok(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.hex_learning_reviews (
  id uuid primary key,
  case_id uuid not null unique references public.hex_portal_cases(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Set once at creation and never changed. The recording and words stay on the
  -- author's own request; the unit's label stays on the case if the unit goes.
  request_id uuid references public.ai_field_requests(id) on delete cascade,
  -- Every field message the write-up was built from, in the order they were
  -- used: the first is request_id. References only; words and recordings stay
  -- on the author's own requests. Appended, never reordered or removed.
  source_request_ids uuid[] not null default '{}' check (cardinality(source_request_ids) <= 20),
  unit_id uuid references public.custom_work_units(id) on delete set null,
  issue text check (length(issue) <= 4000),
  what_happened text check (length(what_happened) <= 4000),
  impact text check (length(impact) <= 4000),
  impact_minutes integer check (impact_minutes between 0 and 100000),
  impact_cost_cents bigint check (impact_cost_cents between 0 and 100000000),
  lesson_learned text check (length(lesson_learned) <= 4000),
  preventive_action text check (length(preventive_action) <= 4000),
  unknown_fields text[] not null default '{}' check (unknown_fields <@ array['issue','what_happened','impact','lesson_learned','preventive_action']),
  state text not null default 'draft' check (state in ('draft','submitted','changes_requested','approved','withdrawn')),
  revision integer not null default 1 check (revision > 0),
  reviewer_id uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_as_oversight boolean not null default false,
  -- The exact supervisor approval an export or delivery refers to.
  approved_revision integer,
  approval_event_id uuid,
  approved_fingerprint text check (approved_fingerprint ~ '^[0-9a-f]{64}$'),
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.profiles(id) on delete set null,
  -- Opaque historical actor only: profile purge may unlink the live person, but
  -- an authorized supervisor must still finish this exact pending removal.
  withdrawn_actor_id uuid,
  withdrawal_event_id uuid,
  withdrawal_reason text check (length(withdrawal_reason) <= 4000),
  -- Role at the moment of withdrawal: history, not a current permission.
  withdrawn_by_role text check (withdrawn_by_role in ('supervisor','owner')),
  created_via text not null default 'form' check (created_via in ('form','ask')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'withdrawn') = (withdrawal_event_id is not null and withdrawn_at is not null))
);
create index hex_learning_reviews_author on public.hex_learning_reviews(author_id, updated_at desc);
create index hex_learning_reviews_reviewer on public.hex_learning_reviews(reviewer_id, state, updated_at desc);
create index hex_learning_reviews_project on public.hex_learning_reviews(project_id, state);
create index hex_learning_reviews_request on public.hex_learning_reviews(request_id) where request_id is not null;

-- One row per revision: who did what, and the full write-up as it stood. The
-- server-minted id is what an approval or withdrawal is referred to by.
create table public.hex_learning_review_events (
  id uuid not null default gen_random_uuid() unique,
  review_id uuid not null references public.hex_learning_reviews(id) on delete cascade,
  revision integer not null check (revision > 0),
  action_id uuid not null unique,
  request_hash text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in ('draft_saved','submitted','reassigned','forwarded','changes_requested','approved','withdrawn')),
  state_after text not null,
  reviewer_id uuid references public.profiles(id) on delete set null,
  oversight boolean not null default false,
  note text not null default '' check (length(note) <= 4000),
  content jsonb not null,
  -- The contributing field messages at this revision; an approval binds them.
  source_request_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (review_id, revision)
);
create index hex_learning_review_events_actor on public.hex_learning_review_events(actor_id);
create index hex_learning_review_events_reviewer on public.hex_learning_review_events(reviewer_id);

-- The approved revision on its way to the archive. Only an exact receipt from
-- the receiver makes it delivered; needs_link and pilot_paused are answers,
-- not receipts.
create table public.hex_learning_deliveries (
  review_id uuid not null references public.hex_learning_reviews(id) on delete cascade,
  revision integer not null,
  approval_event_id uuid not null,
  revision_fingerprint text not null check (revision_fingerprint ~ '^[0-9a-f]{64}$'),
  -- removed_remote: the receiver says the lesson was removed on its side (a
  -- Hexcore owner removal). Terminal: no ordinary retry re-adds it.
  status text not null default 'pending' check (status in ('pending','needs_link','pilot_paused','failed','delivered','removed_remote')),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_caller uuid references public.profiles(id) on delete set null,
  last_error text check (last_error ~ '^[a-z_]{1,60}$'),
  receipt_id text check (length(receipt_id) between 1 and 200),
  received_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (review_id, revision),
  foreign key (review_id, revision) references public.hex_learning_review_events(review_id, revision) on delete cascade,
  check ((status in ('delivered','removed_remote')) = (receipt_id is not null and received_at is not null))
);

-- A withdrawal waiting for the receiver to confirm it removed the lesson.
create table public.hex_learning_withdrawals (
  review_id uuid primary key references public.hex_learning_reviews(id) on delete cascade,
  withdrawal_event_id uuid not null references public.hex_learning_review_events(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','failed','removed')),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_caller uuid references public.profiles(id) on delete set null,
  last_error text check (last_error ~ '^[a-z_]{1,60}$'),
  receipt_id text check (length(receipt_id) between 1 and 200),
  received_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'removed') = (receipt_id is not null and received_at is not null))
);

-- Everything goes through the functions below; nothing is read or written raw.
alter table public.hex_learning_reviews enable row level security;
alter table public.hex_learning_review_events enable row level security;
alter table public.hex_learning_deliveries enable row level security;
alter table public.hex_learning_withdrawals enable row level security;
revoke all on public.hex_learning_reviews, public.hex_learning_review_events, public.hex_learning_deliveries, public.hex_learning_withdrawals from public, anon, authenticated;
grant all on public.hex_learning_reviews, public.hex_learning_review_events, public.hex_learning_deliveries, public.hex_learning_withdrawals to service_role;

-- ---------------------------------------------------------------------------
-- 3. The write-up's shape
-- ---------------------------------------------------------------------------
-- Normalised content: every key present, blank text is null, Unknown is only
-- for a heading with no answer. Mirrors app/src/lib/hexLearningDraft.ts.
create function public._hex_learning_content(p jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare k text; v jsonb; out jsonb := '{}'; unknown jsonb; heading text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or octet_length(p::text) > 30000 then raise exception 'This write-up is too large or invalid.'; end if;
  for k, v in select * from jsonb_each(p) loop
    if k not in ('issue','what_happened','impact','lesson_learned','preventive_action','impact_minutes','impact_cost_cents','unknown') then
      raise exception 'Unknown write-up field.';
    end if;
  end loop;
  foreach heading in array array['issue','what_happened','impact','lesson_learned','preventive_action'] loop
    v := p -> heading;
    if v is not null and jsonb_typeof(v) not in ('string','null') then raise exception 'Each heading is text.'; end if;
    if length(v #>> '{}') > 4000 then raise exception 'Keep each heading under 4000 characters.'; end if;
    out := out || jsonb_build_object(heading, nullif(btrim(coalesce(v #>> '{}', '')), ''));
  end loop;
  foreach k in array array['impact_minutes','impact_cost_cents'] loop
    v := p -> k;
    if v is not null and jsonb_typeof(v) <> 'null' and (jsonb_typeof(v) <> 'number' or (v::text)::numeric <> trunc((v::text)::numeric)
       or (v::text)::numeric < 0 or (v::text)::numeric > case when k = 'impact_minutes' then 100000 else 100000000 end) then
      raise exception 'Enter impact minutes and cost as whole numbers, or leave them blank.';
    end if;
    out := out || jsonb_build_object(k, case when jsonb_typeof(v) = 'number' then v end);
  end loop;
  unknown := coalesce(p -> 'unknown', '[]');
  if jsonb_typeof(unknown) <> 'array' or exists (select 1 from jsonb_array_elements(unknown) x
     where jsonb_typeof(x) <> 'string' or x #>> '{}' not in ('issue','what_happened','impact','lesson_learned','preventive_action')) then
    raise exception 'Unknown must name write-up headings.';
  end if;
  if exists (select 1 from jsonb_array_elements_text(unknown) x where out ->> x is not null
             or (x = 'impact' and (out ->> 'impact_minutes' is not null or out ->> 'impact_cost_cents' is not null))) then
    raise exception 'A heading cannot be both answered and Unknown.';
  end if;
  return out || jsonb_build_object('unknown', (select coalesce(jsonb_agg(distinct x order by x), '[]') from jsonb_array_elements_text(unknown) x));
end $$;
revoke all on function public._hex_learning_content(jsonb) from public, anon, authenticated;

-- Headings with neither an answer nor an explicit Unknown.
create function public._hex_learning_missing(c jsonb) returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(array_agg(k order by o), '{}') from unnest(array['issue','what_happened','impact','lesson_learned','preventive_action']) with ordinality h(k, o)
  where c ->> k is null and not (c -> 'unknown' ? k)
    and not (k = 'impact' and (c ->> 'impact_minutes' is not null or c ->> 'impact_cost_cents' is not null))
$$;
revoke all on function public._hex_learning_missing(jsonb) from public, anon, authenticated;

create function public._hex_learning_content_of(r public.hex_learning_reviews) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('issue', r.issue, 'what_happened', r.what_happened, 'impact', r.impact, 'impact_minutes', r.impact_minutes,
    'impact_cost_cents', r.impact_cost_cents, 'lesson_learned', r.lesson_learned, 'preventive_action', r.preventive_action,
    'unknown', to_jsonb(r.unknown_fields))
$$;
revoke all on function public._hex_learning_content_of(public.hex_learning_reviews) from public, anon, authenticated;

create function public._hex_learning_person(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_id is null then null else jsonb_build_object('id', p_id, 'name', (select display_name from profiles where id = p_id)) end
$$;
revoke all on function public._hex_learning_person(uuid) from public, anon, authenticated;


-- The five headings as the archive names them.
create function public._hex_learning_sections(c jsonb) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('issue', c->'issue', 'whatHappened', c->'what_happened', 'impact', c->'impact',
    'lessonLearned', c->'lesson_learned', 'preventiveAction', c->'preventive_action')
$$;
revoke all on function public._hex_learning_sections(jsonb) from public, anon, authenticated;

-- SHA-256 of the canonical jsonb text of one immutable approval: the five
-- sections, self-reported impact, case/job/unit/source references, author,
-- approver and approval event. Not the caller: an author's retry and a
-- reviewer's retry refer to the same approval.
create function public._hex_learning_fingerprint(p_review uuid, p_revision integer) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'version', 1, 'caseId', r.case_id, 'projectId', r.project_id, 'unitLabel', c.unit_label, 'unitId', r.unit_id,
    'sourceRequestIds', to_jsonb(e.source_request_ids), 'sources', c.sources, 'authorId', r.author_id, 'reviewerId', e.actor_id,
    'approvalEventId', e.id, 'revision', e.revision, 'sections', public._hex_learning_sections(e.content),
    'impactMinutes', e.content->'impact_minutes', 'impactCostCents', e.content->'impact_cost_cents', 'unknown', e.content->'unknown')::text, 'UTF8')), 'hex')
  from hex_learning_reviews r join hex_portal_cases c on c.id = r.case_id
  join hex_learning_review_events e on e.review_id = r.id and e.revision = p_revision and e.action = 'approved'
  where r.id = p_review
$$;
revoke all on function public._hex_learning_fingerprint(uuid, integer) from public, anon, authenticated;

-- What a reader sees. Names only for people; no contact, pay or role detail.
create function public._hex_learning_json(r public.hex_learning_reviews, p_detail boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', r.id, 'case_id', r.case_id, 'project_id', r.project_id, 'state', r.state, 'revision', r.revision,
    'job', (select jsonb_build_object('name', p.name, 'job_code', p.job_code) from projects p where p.id = r.project_id),
    'unit_id', r.unit_id, 'unit_label', c.unit_label, 'question', c.question, 'request_id', r.request_id,
    'author', public._hex_learning_person(r.author_id),
    'reviewer', case when r.reviewer_id is not null then public._hex_learning_person(r.reviewer_id)
      || jsonb_build_object('available', public._hex_learning_reviewer_ok(r.reviewer_id, r.author_id, r.project_id),
                            'can_approve', public._hex_learning_approver_ok(r.reviewer_id, r.author_id, r.project_id)) end,
    'content', public._hex_learning_content_of(r),
    'missing', to_jsonb(public._hex_learning_missing(public._hex_learning_content_of(r))),
    'submitted_at', r.submitted_at, 'decided_at', r.decided_at, 'decided_by', public._hex_learning_person(r.decided_by),
    'decided_as_oversight', r.decided_as_oversight, 'created_via', r.created_via, 'created_at', r.created_at, 'updated_at', r.updated_at,
    'approved_revision', r.approved_revision, 'approval_event_id', r.approval_event_id,
    'last_note', (select e.note from hex_learning_review_events e where e.review_id = r.id and e.action in ('changes_requested','forwarded','reassigned') and e.note <> '' order by e.revision desc limit 1),
    'delivery', (select jsonb_build_object('revision', d.revision, 'status', d.status, 'attempts', d.attempts, 'last_attempt_at', d.last_attempt_at,
                   'last_error', d.last_error, 'receipt_id', d.receipt_id, 'received_at', d.received_at)
                 from hex_learning_deliveries d where d.review_id = r.id order by d.revision desc limit 1),
    'withdrawal', case when r.state = 'withdrawn' then (select jsonb_build_object('status', w.status, 'reason', r.withdrawal_reason, 'withdrawn_at', r.withdrawn_at,
                   'withdrawn_by', public._hex_learning_person(r.withdrawn_by), 'attempts', w.attempts, 'last_error', w.last_error,
                   'receipt_id', w.receipt_id, 'received_at', w.received_at, 'withdrawal_event_id', r.withdrawal_event_id)
                 from hex_learning_withdrawals w where w.review_id = r.id) end)
  || case when p_detail then jsonb_build_object(
    'case', jsonb_build_object('question', c.question, 'answer', c.answer, 'sources', c.sources, 'unit_label', c.unit_label, 'created_at', c.created_at),
    'outcomes', (select coalesce(jsonb_agg(jsonb_build_object('outcome', o.outcome, 'explanation', o.explanation, 'created_at', o.created_at) order by o.created_at), '[]')
                 from hex_portal_outcomes o where o.case_id = c.id),
    -- The recording path comes from the author's own request row, never from a
    -- client; storage decides separately whether this reader may play it.
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'input_kind', q.input_kind, 'transcript', q.transcript, 'sent_at', q.sent_at,
                  'audio_path', q.audio_path) order by s.n), '[]')
                from unnest(r.source_request_ids) with ordinality s(id, n) join ai_field_requests q on q.id = s.id and q.profile_id = r.author_id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('revision', e.revision, 'action', e.action, 'state', e.state_after,
                  'actor', public._hex_learning_person(e.actor_id), 'reviewer', public._hex_learning_person(e.reviewer_id),
                  'oversight', e.oversight, 'note', e.note, 'content', e.content, 'at', e.created_at) order by e.revision), '[]')
                from hex_learning_review_events e where e.review_id = r.id))
  else '{}'::jsonb end
  from hex_portal_cases c where c.id = r.case_id
$$;
revoke all on function public._hex_learning_json(public.hex_learning_reviews, boolean) from public, anon, authenticated;

-- A foreman who forwarded the write-up keeps seeing how it ends (and may retry
-- its delivery); a reviewer who was reassigned away does not.
create function public._hex_learning_forwarded_by(r public.hex_learning_reviews, p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from hex_learning_review_events e where e.review_id = r.id and e.action = 'forwarded' and e.actor_id = p_uid)
    and public._hex_learning_reviewer_ok(p_uid, r.author_id, r.project_id)
$$;
revoke all on function public._hex_learning_forwarded_by(public.hex_learning_reviews, uuid) from public, anon, authenticated;

-- May this person read this write-up right now?
create function public._hex_learning_can_read(r public.hex_learning_reviews, p_uid uuid, p_rank integer) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (r.author_id = p_uid and public._ai_job_visible(r.project_id, p_uid))
    or (r.state <> 'draft' and r.reviewer_id = p_uid and public._hex_learning_reviewer_ok(p_uid, r.author_id, r.project_id))
    or (r.state <> 'draft' and public._hex_learning_forwarded_by(r, p_uid))
    or (r.state <> 'draft' and p_rank >= 2 and public._ai_job_visible(r.project_id, p_uid))
$$;
revoke all on function public._hex_learning_can_read(public.hex_learning_reviews, uuid, integer) from public, anon, authenticated;

-- A replayed action: the same id, by the same person, for the same thing.
create function public._hex_learning_replay(p_action uuid, p_review uuid, p_hash text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e hex_learning_review_events;
begin
  select * into e from hex_learning_review_events where action_id = p_action;
  if not found then return false; end if;
  if e.review_id <> p_review or e.actor_id is distinct from auth.uid() or e.request_hash <> p_hash then
    raise exception 'This action was already used for something different. Reload and try again.' using errcode = '23505';
  end if;
  return true;
end $$;
revoke all on function public._hex_learning_replay(uuid, uuid, text) from public, anon, authenticated;

create function public._hex_learning_stale() returns void language plpgsql set search_path = public, pg_temp as $$
begin
  -- P0001, not 40001: a queued save must dead-letter visibly, never retry forever.
  raise exception 'This write-up changed on another screen. Reload it to see the latest before changing it.' using hint = 'stale_revision';
end $$;
revoke all on function public._hex_learning_stale() from public, anon, authenticated;

create function public._hex_learning_event(r public.hex_learning_reviews, p_action uuid, p_hash text, p_kind text, p_oversight boolean, p_note text) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  insert into hex_learning_review_events(review_id, revision, action_id, request_hash, actor_id, action, state_after, reviewer_id, oversight, note, content, source_request_ids)
  values (r.id, r.revision, p_action, p_hash, auth.uid(), p_kind, r.state, r.reviewer_id, coalesce(p_oversight, false), coalesce(p_note, ''), public._hex_learning_content_of(r), r.source_request_ids)
  returning id
$$;
revoke all on function public._hex_learning_event(public.hex_learning_reviews, uuid, text, text, boolean, text) from public, anon, authenticated;

-- The contributing messages after this save: what was already there, then any
-- new ones in the order given. Each must be the author's own field message from
-- the same Ask conversation as the first; a list never drops or reorders one.
create function public._hex_learning_sources(p_author uuid, p_existing uuid[], p_new uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare out uuid[] := coalesce(p_existing, '{}'); x uuid; conv uuid; first_conv uuid; has_first boolean;
begin
  if p_new is null then return out; end if;
  if array_position(p_new, null) is not null then raise exception 'Invalid message reference.'; end if;
  if cardinality(out) > 0 then select conversation_id into first_conv from ai_field_requests where id = out[1]; end if;
  foreach x in array p_new loop
    if x = any(out) then continue; end if;
    select conversation_id into conv from ai_field_requests where id = x and profile_id = p_author;
    if not found then raise exception 'Only your own messages can be attached as evidence.' using errcode = '42501'; end if;
    has_first := cardinality(out) > 0;
    if has_first and (first_conv is null or conv is distinct from first_conv) then
      raise exception 'Only messages from the same Ask conversation can be attached.' using errcode = '42501';
    end if;
    if not has_first then first_conv := conv; end if;
    out := out || x;
  end loop;
  if cardinality(out) > 20 then raise exception 'A write-up can keep up to 20 messages.'; end if;
  return out;
end $$;
revoke all on function public._hex_learning_sources(uuid, uuid[], uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Author: save a draft, send it to a named reviewer
-- ---------------------------------------------------------------------------
-- p_expected_revision is 0 for a new write-up. The request and unit are fixed
-- at creation: a later save may repeat them or leave them null, never change them.
create function public.hex_learning_save_draft(p_review uuid, p_action uuid, p_case uuid, p_expected_revision integer, p_content jsonb,
  p_request uuid default null, p_unit uuid default null, p_via text default 'form', p_actor uuid default null, p_sources uuid[] default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_actor(p_actor); c hex_portal_cases; r hex_learning_reviews; content jsonb; h text;
  sources uuid[] := coalesce(p_sources, case when p_request is not null then array[p_request] end);
begin
  if p_review is null or p_action is null or p_case is null or p_expected_revision is null or p_content is null then raise exception 'Invalid write-up.'; end if;
  content := public._hex_learning_content(p_content);
  h := md5(jsonb_build_object('op', 'draft', 'case', p_case, 'expected', p_expected_revision, 'content', content, 'sources', sources, 'unit', p_unit)::text);
  perform pg_advisory_xact_lock(hashtextextended(p_case::text, 7610));
  select * into c from hex_portal_cases where id = p_case;
  if not found or c.asker_id <> uid then raise exception 'Only the person who saved this case can write it up.' using errcode = '42501'; end if;
  if not public._ai_job_visible(c.project_id, uid) then raise exception 'That job is unavailable.' using errcode = '42501'; end if;
  if public._hex_learning_replay(p_action, p_review, h) then
    select * into r from hex_learning_reviews where id = p_review;
    return public._hex_learning_json(r, false);
  end if;
  select * into r from hex_learning_reviews where id = p_review for update;
  if not found then
    if p_expected_revision <> 0 then perform public._hex_learning_stale(); end if;
    if exists (select 1 from hex_learning_reviews where case_id = p_case) then
      raise exception 'This case already has a write-up. Open it from your list.' using errcode = '23505';
    end if;
    sources := public._hex_learning_sources(uid, '{}', sources);
    if p_unit is not null and not exists (select 1 from custom_work_units where id = p_unit and project_id = c.project_id) then
      raise exception 'That unit is not on this job.';
    end if;
    insert into hex_learning_reviews(id, case_id, author_id, project_id, request_id, source_request_ids, unit_id, issue, what_happened, impact, impact_minutes,
      impact_cost_cents, lesson_learned, preventive_action, unknown_fields, created_via)
    values (p_review, p_case, uid, c.project_id, sources[1], sources, p_unit, content->>'issue', content->>'what_happened', content->>'impact',
      (content->>'impact_minutes')::integer, (content->>'impact_cost_cents')::bigint, content->>'lesson_learned', content->>'preventive_action',
      array(select jsonb_array_elements_text(content->'unknown')), case when p_via = 'ask' then 'ask' else 'form' end)
    returning * into r;
  else
    if r.case_id <> p_case or r.author_id <> uid then raise exception 'This write-up belongs to someone else.' using errcode = '42501'; end if;
    if r.state not in ('draft','changes_requested') then
      raise exception 'This write-up was sent for review. It can change only if the reviewer asks for changes.';
    end if;
    if r.revision <> p_expected_revision then perform public._hex_learning_stale(); end if;
    if (p_request is not null and r.request_id is not null and p_request is distinct from r.request_id) or (p_unit is not null and p_unit is distinct from r.unit_id) then
      raise exception 'The original message and unit of a write-up cannot be changed.';
    end if;
    -- Later answers from the same conversation add their messages; none is dropped.
    sources := public._hex_learning_sources(uid, r.source_request_ids, sources);
    update hex_learning_reviews set source_request_ids = sources, request_id = coalesce(request_id, sources[1]), issue = content->>'issue', what_happened = content->>'what_happened', impact = content->>'impact',
      impact_minutes = (content->>'impact_minutes')::integer, impact_cost_cents = (content->>'impact_cost_cents')::bigint,
      lesson_learned = content->>'lesson_learned', preventive_action = content->>'preventive_action',
      unknown_fields = array(select jsonb_array_elements_text(content->'unknown')), revision = revision + 1, updated_at = now()
    where id = r.id returning * into r;
  end if;
  perform public._hex_learning_event(r, p_action, h, 'draft_saved', false, null);
  return public._hex_learning_json(r, false);
end $$;
revoke all on function public.hex_learning_save_draft(uuid, uuid, uuid, integer, jsonb, uuid, uuid, text, uuid, uuid[]) from public, anon;
grant execute on function public.hex_learning_save_draft(uuid, uuid, uuid, integer, jsonb, uuid, uuid, text, uuid, uuid[]) to authenticated;

-- Send (or, while it waits, re-send to a different person). The reviewer is an
-- id the author tapped, never a name resolved here.
create function public.hex_learning_submit(p_review uuid, p_action uuid, p_expected_revision integer, p_reviewer uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_actor(p_actor); r hex_learning_reviews; h text; missing text[]; act text;
begin
  if p_review is null or p_action is null or p_expected_revision is null then raise exception 'Invalid write-up.'; end if;
  if p_reviewer is null then raise exception 'Choose who reviews it.'; end if;
  h := md5(jsonb_build_object('op', 'submit', 'expected', p_expected_revision, 'reviewer', p_reviewer)::text);
  select * into r from hex_learning_reviews where id = p_review for update;
  if not found or r.author_id <> uid then raise exception 'Only the author can send this write-up.' using errcode = '42501'; end if;
  if public._hex_learning_replay(p_action, p_review, h) then return public._hex_learning_json(r, false); end if;
  if not public._ai_job_visible(r.project_id, uid) then raise exception 'That job is unavailable.' using errcode = '42501'; end if;
  if r.state in ('approved','withdrawn') then raise exception 'This write-up is already decided.'; end if;
  if r.revision <> p_expected_revision then perform public._hex_learning_stale(); end if;
  if r.state = 'submitted' and r.reviewer_id = p_reviewer then raise exception 'It is already waiting with that reviewer.'; end if;
  missing := public._hex_learning_missing(public._hex_learning_content_of(r));
  if cardinality(missing) > 0 then raise exception 'Answer or mark Unknown: %.', array_to_string(missing, ', '); end if;
  if r.issue is null or r.what_happened is null then raise exception 'Say what the issue was and what happened before sending.'; end if;
  if p_reviewer = uid and rnk < 2 then raise exception 'You cannot review your own write-up. Choose another foreman or supervisor.' using errcode = '42501'; end if;
  if not public._hex_learning_reviewer_ok(p_reviewer, uid, r.project_id) then
    raise exception 'That person cannot review this job. Choose a current foreman or supervisor.' using errcode = '42501';
  end if;
  act := case when r.state = 'submitted' then 'reassigned' else 'submitted' end;
  update hex_learning_reviews set state = 'submitted', reviewer_id = p_reviewer, submitted_at = now(), revision = revision + 1, updated_at = now()
  where id = r.id returning * into r;
  perform public._hex_learning_event(r, p_action, h, act, false, null);
  return public._hex_learning_json(r, false);
end $$;
revoke all on function public.hex_learning_submit(uuid, uuid, integer, uuid, uuid) from public, anon;
grant execute on function public.hex_learning_submit(uuid, uuid, integer, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Review: ask for changes, forward to a supervisor, or (supervisor/owner) approve
-- ---------------------------------------------------------------------------
-- request_changes: the named reviewer, or a supervisor/owner as recorded oversight.
-- forward: the named reviewer hands it to an exact supervisor/owner for approval.
-- approve: only a supervisor/owner — the named one, or as recorded oversight.
create function public.hex_learning_decide(p_review uuid, p_action uuid, p_expected_revision integer, p_decision text, p_note text,
  p_oversight boolean default false, p_forward_to uuid default null, p_actor uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_actor(p_actor); r hex_learning_reviews; h text; note text := btrim(coalesce(p_note, ''));
  oversight boolean := coalesce(p_oversight, false); named boolean; ev uuid; fp text;
begin
  if p_review is null or p_action is null or p_expected_revision is null or p_decision is null
     or p_decision not in ('approve','request_changes','forward') then raise exception 'Invalid decision.'; end if;
  if length(note) > 4000 then raise exception 'Keep the note under 4000 characters.'; end if;
  h := md5(jsonb_build_object('op', 'decide', 'expected', p_expected_revision, 'decision', p_decision, 'note', note, 'oversight', oversight, 'to', p_forward_to)::text);
  select * into r from hex_learning_reviews where id = p_review for update;
  if not found then raise exception 'This write-up is unavailable.' using errcode = '42501'; end if;
  -- Only a current supervisor/owner may act on their own write-up, and only by
  -- this explicit decision on the revision they are looking at.
  if r.author_id = uid and rnk < 2 then raise exception 'You cannot review your own write-up. Send it to another foreman or supervisor.' using errcode = '42501'; end if;
  -- A retry of this person's own tap returns what it did, even once the write-up
  -- has moved on (a forward leaves the forwarder no longer named).
  if public._hex_learning_replay(p_action, p_review, h) then return public._hex_learning_json(r, false); end if;
  named := r.reviewer_id = uid and public._hex_learning_reviewer_ok(uid, r.author_id, r.project_id);
  if p_decision = 'approve' then
    -- Supervisor authority, checked now: a demoted or revoked approver cannot approve.
    if rnk < 2 or not public._hex_learning_approver_ok(uid, r.author_id, r.project_id) then
      raise exception 'Only a supervisor or owner can approve for the Hex-Portal archive. Forward it to one.' using errcode = '42501';
    end if;
    if not named and not oversight then raise exception 'This write-up is not assigned to you. Decide as oversight to approve it.' using errcode = '42501'; end if;
  elsif p_decision = 'forward' then
    if not named then raise exception 'Only the named reviewer can forward this write-up.' using errcode = '42501'; end if;
    if p_forward_to is null or p_forward_to = uid or not public._hex_learning_approver_ok(p_forward_to, r.author_id, r.project_id) then
      raise exception 'Choose a current supervisor or owner (not the author or yourself) to approve it.' using errcode = '42501';
    end if;
  else
    if not named and not (oversight and rnk >= 2 and public._ai_job_visible(r.project_id, uid)) then
      raise exception 'This write-up is not assigned to you, or your reviewer access changed.' using errcode = '42501';
    end if;
  end if;
  if oversight and (rnk < 2 or not public._ai_job_visible(r.project_id, uid)) then raise exception 'Only a supervisor or owner can decide as oversight.' using errcode = '42501'; end if;
  if r.state <> 'submitted' then raise exception 'Only a write-up waiting for review can be decided.'; end if;
  if r.revision <> p_expected_revision then perform public._hex_learning_stale(); end if;
  if p_decision = 'request_changes' and note = '' then raise exception 'Say what needs to change.'; end if;
  if p_decision = 'forward' then
    update hex_learning_reviews set reviewer_id = p_forward_to, revision = revision + 1, updated_at = now() where id = r.id returning * into r;
    perform public._hex_learning_event(r, p_action, h, 'forwarded', false, note);
  elsif p_decision = 'request_changes' then
    update hex_learning_reviews set state = 'changes_requested', decided_at = now(), decided_by = uid, decided_as_oversight = oversight and not named,
      revision = revision + 1, updated_at = now() where id = r.id returning * into r;
    perform public._hex_learning_event(r, p_action, h, 'changes_requested', oversight and not named, note);
  else
    update hex_learning_reviews set state = 'approved', decided_at = now(), decided_by = uid, decided_as_oversight = oversight and not named,
      revision = revision + 1, updated_at = now() where id = r.id returning * into r;
    ev := public._hex_learning_event(r, p_action, h, 'approved', oversight and not named, note);
    fp := public._hex_learning_fingerprint(r.id, r.revision);
    update hex_learning_reviews set approved_revision = r.revision, approval_event_id = ev, approved_fingerprint = fp where id = r.id returning * into r;
    -- Approved is not delivered: it waits here for the receiver's receipt.
    insert into hex_learning_deliveries(review_id, revision, approval_event_id, revision_fingerprint) values (r.id, r.revision, ev, fp);
  end if;
  return public._hex_learning_json(r, false);
end $$;
revoke all on function public.hex_learning_decide(uuid, uuid, integer, text, text, boolean, uuid, uuid) from public, anon;
grant execute on function public.hex_learning_decide(uuid, uuid, integer, text, text, boolean, uuid, uuid) to authenticated;

-- Recovery when the named reviewer cannot act (away, demoted, removed): a
-- supervisor/owner hands it to another exact reviewer, with a recorded reason.
create function public.hex_learning_reassign(p_review uuid, p_action uuid, p_expected_revision integer, p_reviewer uuid, p_reason text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_actor(p_actor); r hex_learning_reviews; h text; reason text := btrim(coalesce(p_reason, ''));
begin
  if p_review is null or p_action is null or p_expected_revision is null or p_reviewer is null then raise exception 'Invalid reassignment.'; end if;
  if reason = '' or length(reason) > 4000 then raise exception 'Say why it is being reassigned.'; end if;
  h := md5(jsonb_build_object('op', 'reassign', 'expected', p_expected_revision, 'reviewer', p_reviewer, 'reason', reason)::text);
  select * into r from hex_learning_reviews where id = p_review for update;
  if not found or rnk < 2 or r.author_id = uid or not public._ai_job_visible(r.project_id, uid) then
    raise exception 'Only a supervisor or owner (not the author) can reassign this write-up.' using errcode = '42501';
  end if;
  if public._hex_learning_replay(p_action, p_review, h) then return public._hex_learning_json(r, false); end if;
  if r.state <> 'submitted' then raise exception 'Only a write-up waiting for review can be reassigned.'; end if;
  if r.revision <> p_expected_revision then perform public._hex_learning_stale(); end if;
  if p_reviewer = r.reviewer_id then raise exception 'It is already waiting with that reviewer.'; end if;
  if not public._hex_learning_reviewer_ok(p_reviewer, r.author_id, r.project_id) then
    raise exception 'That person cannot review this job. Choose a current foreman or supervisor.' using errcode = '42501';
  end if;
  update hex_learning_reviews set reviewer_id = p_reviewer, revision = revision + 1, updated_at = now() where id = r.id returning * into r;
  perform public._hex_learning_event(r, p_action, h, 'reassigned', true, reason);
  return public._hex_learning_json(r, false);
end $$;
revoke all on function public.hex_learning_reassign(uuid, uuid, integer, uuid, text, uuid) from public, anon;
grant execute on function public.hex_learning_reassign(uuid, uuid, integer, uuid, text, uuid) to authenticated;

-- Take an approved write-up out of the archive. Immediate here (every export
-- and packet stops at once); the receiver's removal waits in the outbox.
create function public.hex_learning_withdraw(p_review uuid, p_action uuid, p_expected_revision integer, p_reason text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_actor(p_actor); r hex_learning_reviews; h text; reason text := btrim(coalesce(p_reason, '')); ev uuid;
begin
  if p_review is null or p_action is null or p_expected_revision is null then raise exception 'Invalid withdrawal.'; end if;
  if reason = '' or length(reason) > 4000 then raise exception 'Say why it is being withdrawn.'; end if;
  h := md5(jsonb_build_object('op', 'withdraw', 'expected', p_expected_revision, 'reason', reason)::text);
  select * into r from hex_learning_reviews where id = p_review for update;
  if not found or rnk < 2 or not public._ai_job_visible(r.project_id, uid) then
    raise exception 'Only a supervisor or owner can withdraw a lesson from Hex-Portal.' using errcode = '42501';
  end if;
  if public._hex_learning_replay(p_action, p_review, h) then return public._hex_learning_json(r, false); end if;
  if r.state <> 'approved' then raise exception 'Only an approved lesson can be withdrawn.'; end if;
  if r.revision <> p_expected_revision then perform public._hex_learning_stale(); end if;
  update hex_learning_reviews set state = 'withdrawn', revision = revision + 1, withdrawn_at = now(), withdrawn_by = uid, withdrawn_actor_id = uid,
    withdrawn_by_role = public._hex_learning_role_name(uid), withdrawal_reason = reason,
    withdrawal_event_id = gen_random_uuid(), updated_at = now() where id = r.id returning * into r;
  -- The event carries the same id the withdrawal is known by.
  ev := public._hex_learning_event(r, p_action, h, 'withdrawn', false, reason);
  update hex_learning_review_events set id = r.withdrawal_event_id where id = ev;
  insert into hex_learning_withdrawals(review_id, withdrawal_event_id) values (r.id, r.withdrawal_event_id);
  return public._hex_learning_json(r, false);
end $$;
revoke all on function public.hex_learning_withdraw(uuid, uuid, integer, text, uuid) from public, anon;
grant execute on function public.hex_learning_withdraw(uuid, uuid, integer, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Reading
-- ---------------------------------------------------------------------------
-- mine: what I wrote. assigned: waiting with me by name. oversight: supervisors
-- and owners, everything sent (drafts stay the author's until sent).
create function public.hex_learning_list(p_scope text, p_project uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_caller(); out jsonb;
begin
  -- NULL is not a scope: it would slip past NOT IN and land in the oversight branch.
  if p_scope is null or p_scope not in ('mine','assigned','oversight') then raise exception 'Invalid list.'; end if;
  if p_scope = 'oversight' and rnk < 2 then raise exception 'Only supervisors and owners have oversight.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(public._hex_learning_json(r, false) order by (r.state = 'submitted') desc, r.updated_at desc), '[]') into out
  from (select x.id from hex_learning_reviews x
        where (p_project is null or x.project_id = p_project)
          and case p_scope when 'mine' then x.author_id = uid
                           when 'assigned' then x.state <> 'draft' and ((x.reviewer_id = uid and public._hex_learning_reviewer_ok(uid, x.author_id, x.project_id))
                                                                        or public._hex_learning_forwarded_by(x, uid))
                           when 'oversight' then x.state <> 'draft' and public._ai_job_visible(x.project_id, uid)
                           else false end
        order by (x.state = 'submitted') desc, x.updated_at desc limit 100) s
  join hex_learning_reviews r on r.id = s.id;
  return out;
end $$;
revoke all on function public.hex_learning_list(text, uuid) from public, anon;
grant execute on function public.hex_learning_list(text, uuid) to authenticated;

create function public.hex_learning_get(p_review uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_caller(); r hex_learning_reviews; named boolean;
begin
  if p_review is null then raise exception 'This write-up is unavailable.' using errcode = '42501'; end if;
  select * into r from hex_learning_reviews where id = p_review;
  if not found or not public._hex_learning_can_read(r, uid, rnk) then raise exception 'This write-up is unavailable.' using errcode = '42501'; end if;
  named := r.reviewer_id = uid and public._hex_learning_reviewer_ok(uid, r.author_id, r.project_id);
  return public._hex_learning_json(r, true) || jsonb_build_object('viewer', jsonb_build_object(
    'is_author', r.author_id = uid,
    'is_reviewer', named,
    'can_approve', public._hex_learning_approver_ok(uid, r.author_id, r.project_id),
    'can_oversee', rnk >= 2,
    'can_retry', r.state = 'approved' and not exists (select 1 from hex_learning_deliveries d where d.review_id = r.id and d.status = 'removed_remote'),
    'can_withdraw', rnk >= 2 and r.state = 'approved',
    'can_send_withdrawal', rnk >= 2 and r.state = 'withdrawn'));
end $$;
revoke all on function public.hex_learning_get(uuid) from public, anon;
grant execute on function public.hex_learning_get(uuid) to authenticated;

-- Reviewer choices. With a name, exact (case- and space-insensitive) matches come
-- first and say so; anything else is a suggestion the person must tap.
-- p_purpose: submit (the author choosing), forward (the named reviewer choosing a
-- supervisor/owner), reassign (a supervisor/owner recovering a stuck write-up).
create function public.hex_learning_reviewers(p_project uuid, p_name text default '', p_review uuid default null, p_purpose text default 'submit') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_caller(); q text := lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
  choices jsonb; exact jsonb; author uuid := uid; r hex_learning_reviews; final boolean := false;
begin
  if length(q) > 100 then raise exception 'Search for a shorter name.'; end if;
  if p_project is null or p_purpose is null or p_purpose not in ('submit','forward','reassign') then raise exception 'Invalid reviewer search.'; end if;
  if not public._ai_job_visible(p_project, uid) then raise exception 'That job is unavailable.' using errcode = '42501'; end if;
  if p_purpose <> 'submit' then
    select * into r from hex_learning_reviews where id = p_review and project_id = p_project;
    if not found or (p_purpose = 'forward' and not (r.reviewer_id = uid and public._hex_learning_reviewer_ok(uid, r.author_id, r.project_id)))
       or (p_purpose = 'reassign' and (rnk < 2 or r.author_id = uid)) then
      raise exception 'This write-up is unavailable.' using errcode = '42501';
    end if;
    author := r.author_id; final := p_purpose = 'forward';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name,
      'role', case public.role_rank(p.role) when 3 then 'owner' when 2 then 'supervisor' else 'foreman' end,
      'exact', lower(regexp_replace(btrim(p.display_name), '\s+', ' ', 'g')) = q)
      order by lower(regexp_replace(btrim(p.display_name), '\s+', ' ', 'g')) = q desc, p.display_name, p.id), '[]')
  -- A supervisor/owner author may pick themselves (reviewer_ok decides); nobody forwards or reassigns to themselves.
  into choices from (select * from profiles p where (p.id <> uid or p_purpose = 'submit') and public._hex_learning_reviewer_ok(p.id, author, p_project)
    and (not final or public._hex_learning_rank(p.id) >= 2)
    and (q = '' or lower(p.display_name) like '%' || replace(replace(q, '%', ''), '_', '') || '%'
         or exists (select 1 from regexp_split_to_table(q, ' ') w where length(w) >= 2 and lower(p.display_name) like '%' || replace(replace(w, '%', ''), '_', '') || '%'))
    order by p.display_name limit 30) p;
  select coalesce(jsonb_agg(x), '[]') into exact from jsonb_array_elements(choices) x where (x->>'exact')::boolean;
  return jsonb_build_object('status', case when q = '' then 'not_named' when jsonb_array_length(exact) = 1 then 'exact'
      when jsonb_array_length(exact) > 1 or jsonb_array_length(choices) > 0 then 'choose' else 'none' end,
    'match', case when q <> '' and jsonb_array_length(exact) = 1 then exact->0 end, 'choices', choices);
end $$;
revoke all on function public.hex_learning_reviewers(uuid, text, uuid, text) from public, anon;
grant execute on function public.hex_learning_reviewers(uuid, text, uuid, text) to authenticated;

-- The in-app notification feed: write-ups waiting with this person by name.
-- One row per review and revision, so a forward reaches exactly the named
-- supervisor, a new revision is a new notice, and a retried tap is not.
create function public.hex_learning_waiting() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_caller();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'revision', r.revision, 'job_code', p.job_code, 'unit_label', c.unit_label,
      'author', (select display_name from profiles where id = r.author_id)) order by r.updated_at desc), '[]')
    from hex_learning_reviews r join hex_portal_cases c on c.id = r.case_id join projects p on p.id = r.project_id
    where r.state = 'submitted' and r.reviewer_id = uid and public._hex_learning_reviewer_ok(uid, r.author_id, r.project_id));
end $$;
revoke all on function public.hex_learning_waiting() from public, anon;
grant execute on function public.hex_learning_waiting() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The Hex-Portal bridge (BRIDGE-CONTRACT.md): read-only proofs
-- ---------------------------------------------------------------------------
-- The approved packet, without who is asking.
create function public._hex_learning_packet(r public.hex_learning_reviews) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('version', 1, 'caseId', r.case_id, 'projectId', r.project_id, 'revision', r.approved_revision,
    'reviewerId', e.actor_id, 'approvalEventId', e.id, 'approvedAt', e.created_at, 'revisionFingerprint', r.approved_fingerprint,
    'reviewerRole', case public._hex_learning_rank(e.actor_id) when 3 then 'owner' when 2 then 'supervisor' end,
    'status', 'approved', 'authorId', r.author_id, 'unitLabel', nullif(c.unit_label, ''), 'sections', public._hex_learning_sections(e.content),
    'unknownFields', (select coalesce(jsonb_agg(case k when 'what_happened' then 'whatHappened' when 'lesson_learned' then 'lessonLearned'
                        when 'preventive_action' then 'preventiveAction' else k end order by o), '[]')
                      from unnest(array['issue','what_happened','impact','lesson_learned','preventive_action']) with ordinality h(k, o) where e.content->'unknown' ? k),
    'selfReportedImpact', jsonb_build_object('minutes', e.content->'impact_minutes', 'costCents', e.content->'impact_cost_cents'))
  from hex_learning_review_events e join hex_portal_cases c on c.id = r.case_id
  where e.review_id = r.id and e.revision = r.approved_revision and e.id = r.approval_event_id and e.action = 'approved'
$$;
revoke all on function public._hex_learning_packet(public.hex_learning_reviews) from public, anon, authenticated;

-- Is this approval still exactly what was approved, by someone who still may?
create function public._hex_learning_approval_current(r public.hex_learning_reviews) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select r.state = 'approved' and exists (select 1 from hex_learning_review_events e
    where e.review_id = r.id and e.revision = r.approved_revision and e.id = r.approval_event_id and e.action = 'approved'
      and e.actor_id is not null and public._hex_learning_approver_ok(e.actor_id, r.author_id, r.project_id))
    and public._hex_learning_fingerprint(r.id, r.approved_revision) = r.approved_fingerprint
    -- Removed in Hexcore is terminal: not offered for export or retry again.
    and not exists (select 1 from hex_learning_deliveries d where d.review_id = r.id and d.status = 'removed_remote')
$$;
revoke all on function public._hex_learning_approval_current(public.hex_learning_reviews) from public, anon, authenticated;

-- Who may ask for (and so retry) delivery of an approval: the author, the
-- current named reviewer, a foreman who forwarded it, or a current
-- supervisor/owner who can see the job. Checked against the live profile.
create function public._hex_learning_may_deliver(r public.hex_learning_reviews, p_uid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._hex_learning_rank(p_uid) is not null and (
    (r.author_id = p_uid and public._ai_job_visible(r.project_id, p_uid))
    or (r.reviewer_id = p_uid and public._hex_learning_reviewer_ok(p_uid, r.author_id, r.project_id))
    or public._hex_learning_forwarded_by(r, p_uid)
    or (public._hex_learning_rank(p_uid) >= 2 and public._ai_job_visible(r.project_id, p_uid)))
$$;
revoke all on function public._hex_learning_may_deliver(public.hex_learning_reviews, uuid) from public, anon, authenticated;

-- A current supervisor/owner who can see the job: the only proof removal needs.
-- The original withdrawer or approver may have left; removal must still finish.
create function public._hex_learning_role_name(p_uid uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case public._hex_learning_rank(p_uid) when 3 then 'owner' when 2 then 'supervisor' end
$$;
revoke all on function public._hex_learning_role_name(uuid) from public, anon, authenticated;

-- Hexcore reads this with the delivering person's own JWT, before and after it
-- stores a receipt. Author, a reviewer who handled it, or a current
-- supervisor/owner may retry; retrying never grants a new approval.
create function public.hex_portal_review_packet(p_case_id uuid, p_revision integer, p_approval_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_caller(); r hex_learning_reviews;
begin
  if p_case_id is null or p_revision is null or p_approval_event_id is null then raise exception 'Invalid packet request.' using errcode = '22023'; end if;
  select * into r from hex_learning_reviews where case_id = p_case_id;
  if not found or r.approved_revision is distinct from p_revision or r.approval_event_id is distinct from p_approval_event_id
     or not public._hex_learning_approval_current(r) then
    raise exception 'This approval is not current.' using errcode = '42501';
  end if;
  if not public._hex_learning_may_deliver(r, uid) then
    raise exception 'This approval is unavailable to you.' using errcode = '42501';
  end if;
  return public._hex_learning_packet(r) || jsonb_build_object('callerId', uid, 'deliveryAuthorized', true);
end $$;
revoke all on function public.hex_portal_review_packet(uuid, integer, uuid) from public, anon;
grant execute on function public.hex_portal_review_packet(uuid, integer, uuid) to authenticated;

-- The approved export for one job, caseId ascending: current,
-- supervisor-approved, not withdrawn. Replaces raw case/outcome reads on the
-- Hexcore side; Forge's own case evidence and local screens are untouched.
-- p_case_id is an exact lookup (for sharing), not a first-page search. At most
-- 30 are returned; one row past the page (never returned) decides whether
-- nextCursor, the last RETURNED caseId, is given — so no valid tail is lost.
create function public.hex_portal_approved_cases(p_project_id uuid, p_after uuid default null, p_case_id uuid default null, p_limit integer default 31) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_caller(); rows jsonb; more boolean; page integer;
begin
  if rnk < 2 then raise exception 'Only a supervisor or owner can read the approved export.' using errcode = '42501'; end if;
  if p_project_id is null or p_limit is null or p_limit not between 1 and 31 or (p_after is not null and p_case_id is not null) then
    raise exception 'Invalid export request.' using errcode = '22023';
  end if;
  if not public._ai_job_visible(p_project_id, uid) then raise exception 'That job is unavailable.' using errcode = '42501'; end if;
  page := least(p_limit, 30);
  select coalesce(jsonb_agg(public._hex_learning_packet(x) || jsonb_build_object('callerId', uid, 'deliveryAuthorized', true) order by x.case_id), '[]'),
         count(*) > page
  into rows, more
  from (select * from hex_learning_reviews y where y.project_id = p_project_id and y.state = 'approved'
          and (p_after is null or y.case_id > p_after) and (p_case_id is null or y.case_id = p_case_id)
          and public._hex_learning_approval_current(y)
        order by y.case_id limit page + 1) x;
  if more then rows := rows - page; end if;
  return jsonb_build_object('items', rows, 'nextCursor', case when more then rows -> (page - 1) ->> 'caseId' end);
end $$;
revoke all on function public.hex_portal_approved_cases(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.hex_portal_approved_cases(uuid, uuid, uuid, integer) to authenticated;

-- Proof that a supervisor/owner withdrew this exact approval. No original
-- evidence or sections: only the references the receiver tombstones.
create function public.hex_portal_withdrawal_packet(p_case_id uuid, p_withdrawal_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); rnk integer := public._hex_learning_caller(); r hex_learning_reviews;
begin
  if p_case_id is null or p_withdrawal_event_id is null then raise exception 'Invalid withdrawal request.' using errcode = '22023'; end if;
  if rnk < 2 then raise exception 'Only a supervisor or owner can withdraw a lesson.' using errcode = '42501'; end if;
  select * into r from hex_learning_reviews where case_id = p_case_id;
  if not found or r.state <> 'withdrawn' or r.withdrawal_event_id is distinct from p_withdrawal_event_id or not public._ai_job_visible(r.project_id, uid) then
    raise exception 'This withdrawal is not current.' using errcode = '42501';
  end if;
  -- withdrawnBy/At/Role are history from the withdrawal itself; callerId and
  -- callerRole are the CURRENT supervisor/owner completing removal. No check on
  -- whether the original withdrawer or approver still has access, and none on
  -- the pilot link: removal always stays possible.
  return jsonb_build_object('version', 1, 'caseId', r.case_id, 'projectId', r.project_id, 'withdrawalEventId', r.withdrawal_event_id,
    'withdrawnAt', r.withdrawn_at, 'withdrawnBy', r.withdrawn_actor_id, 'withdrawnByRole', r.withdrawn_by_role,
    'callerId', uid, 'callerRole', public._hex_learning_role_name(uid), 'withdrawalAuthorized', true, 'revisionFingerprint', r.approved_fingerprint);
end $$;
revoke all on function public.hex_portal_withdrawal_packet(uuid, uuid) from public, anon;
grant execute on function public.hex_portal_withdrawal_packet(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Recording what the receiver said (service only; the edge function calls
--    these after checking the response against the packet it re-read)
-- ---------------------------------------------------------------------------
create function public.hex_learning_record_delivery(p_case_id uuid, p_revision integer, p_approval_event_id uuid, p_fingerprint text, p_caller uuid,
  p_outcome text, p_receipt_id text default null, p_received_at timestamptz default null, p_error text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r hex_learning_reviews; d hex_learning_deliveries;
begin
  if p_case_id is null or p_revision is null or p_approval_event_id is null or p_fingerprint is null or p_caller is null
     or p_outcome is null or p_outcome not in ('delivered','needs_link','pilot_paused','failed','removed_remote') then raise exception 'Invalid delivery record.'; end if;
  select * into r from hex_learning_reviews where case_id = p_case_id for update;
  if not found then raise exception 'Unknown lesson.'; end if;
  -- A withdrawn lesson never becomes delivered again, however late a reply arrives.
  if r.state = 'withdrawn' then raise exception 'This lesson was withdrawn. Nothing was recorded.'; end if;
  if r.state <> 'approved' or r.approved_revision <> p_revision or r.approval_event_id <> p_approval_event_id or r.approved_fingerprint <> p_fingerprint then
    raise exception 'This approval is not current. Nothing was recorded.';
  end if;
  select * into d from hex_learning_deliveries where review_id = r.id and revision = p_revision for update;
  if d.status = 'removed_remote' then return 'removed_remote'; end if;
  -- The exact same receipt again changes nothing and is safe to acknowledge.
  if p_outcome = 'delivered' and d.status = 'delivered' and d.receipt_id = p_receipt_id and d.received_at = p_received_at then return 'delivered'; end if;
  -- The service role carries no authority of its own: re-check, inside this
  -- transaction, that the approval and its final approver are still current and
  -- that the person who tapped may still deliver it.
  if not public._hex_learning_approval_current(r) then raise exception 'This approval is not current. Nothing was recorded.'; end if;
  if not public._hex_learning_may_deliver(r, p_caller) then raise exception 'The person who sent this can no longer deliver it. Nothing was recorded.'; end if;
  if p_outcome in ('delivered','removed_remote') then
    if p_receipt_id is null or length(p_receipt_id) not between 1 and 200 or p_received_at is null or not isfinite(p_received_at) then
      raise exception 'This needs the receiver''s receipt.';
    end if;
    if d.status = p_outcome then
      if d.receipt_id = p_receipt_id and d.received_at = p_received_at then return p_outcome; end if;
      raise exception 'A different receipt is already recorded.';
    end if;
  elsif d.status = 'delivered' then
    return 'delivered';
  end if;
  update hex_learning_deliveries set status = p_outcome, attempts = attempts + 1, last_attempt_at = now(),
    last_caller = case when exists (select 1 from profiles where id = p_caller) then p_caller end,
    last_error = case when p_outcome = 'failed' then case when coalesce(p_error, '') ~ '^[a-z_]{1,60}$' then p_error else 'unconfirmed' end end,
    receipt_id = case when p_outcome in ('delivered','removed_remote') then p_receipt_id end,
    received_at = case when p_outcome in ('delivered','removed_remote') then p_received_at end
  where review_id = r.id and revision = p_revision;
  return p_outcome;
end $$;
revoke all on function public.hex_learning_record_delivery(uuid, integer, uuid, text, uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.hex_learning_record_delivery(uuid, integer, uuid, text, uuid, text, text, timestamptz, text) to service_role;

create function public.hex_learning_record_withdrawal(p_case_id uuid, p_withdrawal_event_id uuid, p_caller uuid, p_outcome text,
  p_receipt_id text default null, p_received_at timestamptz default null, p_error text default null) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare r hex_learning_reviews; w hex_learning_withdrawals;
begin
  if p_case_id is null or p_withdrawal_event_id is null or p_caller is null or p_outcome is null or p_outcome not in ('removed','failed') then
    raise exception 'Invalid withdrawal record.';
  end if;
  select * into r from hex_learning_reviews where case_id = p_case_id for update;
  if not found or r.state <> 'withdrawn' or r.withdrawal_event_id <> p_withdrawal_event_id then raise exception 'This withdrawal is not current.'; end if;
  select * into w from hex_learning_withdrawals where review_id = r.id for update;
  -- A recorded tombstone stays recorded; the same receipt again is acknowledged.
  if p_outcome = 'removed' and w.status = 'removed' and w.receipt_id = p_receipt_id and w.received_at = p_received_at then return 'removed'; end if;
  -- Only a CURRENT supervisor/owner who can see the job may record removal;
  -- nothing depends on the original withdrawer or approver still being here.
  if coalesce(public._hex_learning_rank(p_caller), 0) < 2 or not public._ai_job_visible(r.project_id, p_caller) then
    raise exception 'Only a current supervisor or owner can complete removal. Nothing was recorded.';
  end if;
  if p_outcome = 'removed' then
    if p_receipt_id is null or length(p_receipt_id) not between 1 and 200 or p_received_at is null or not isfinite(p_received_at) then
      raise exception 'A removal needs the receiver''s receipt.';
    end if;
    if w.status = 'removed' then
      if w.receipt_id = p_receipt_id and w.received_at = p_received_at then return 'removed'; end if;
      raise exception 'A different receipt is already recorded.';
    end if;
  elsif w.status = 'removed' then
    return 'removed';
  end if;
  update hex_learning_withdrawals set status = p_outcome, attempts = attempts + 1, last_attempt_at = now(),
    last_caller = case when exists (select 1 from profiles where id = p_caller) then p_caller end,
    last_error = case when p_outcome = 'failed' then case when coalesce(p_error, '') ~ '^[a-z_]{1,60}$' then p_error else 'unconfirmed' end end,
    receipt_id = case when p_outcome = 'removed' then p_receipt_id end, received_at = case when p_outcome = 'removed' then p_received_at end
  where review_id = r.id;
  return p_outcome;
end $$;
revoke all on function public.hex_learning_record_withdrawal(uuid, uuid, uuid, text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.hex_learning_record_withdrawal(uuid, uuid, uuid, text, text, timestamptz, text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. The original recording, for the one assigned reviewer
-- ---------------------------------------------------------------------------
-- The speaker and supervisors/owners could already play it. A named foreman may
-- now play exactly the recordings of the messages a write-up was built from,
-- while it is with them and they remain its eligible reviewer. Not the rest of
-- the author's conversation, no other peer read, and nothing is copied.
create function public.hex_learning_memo_readable(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_name is not null and exists (select 1 from hex_learning_reviews r join ai_field_requests q on q.id = any(r.source_request_ids) and q.profile_id = r.author_id
    where q.audio_path = p_name and r.reviewer_id = auth.uid() and r.state in ('submitted','changes_requested','approved','withdrawn')
      and public._hex_learning_reviewer_ok(r.reviewer_id, r.author_id, r.project_id))
$$;
revoke all on function public.hex_learning_memo_readable(text) from public, anon;
grant execute on function public.hex_learning_memo_readable(text) to authenticated;

-- Both the permissive grant and its restrictive boundary (20261024000000) gain
-- the same one clause; everything else is restated unchanged.
drop policy if exists ai_field_memos_read on storage.objects;
create policy ai_field_memos_read on storage.objects for select to authenticated using (
  bucket_id = 'ai-field-memos' and not public.is_partner_user() and (
    (public.custom_work_internal() and (split_part(name, '/', 1) = auth.uid()::text or public._is_supervisor(auth.uid())))
    or public.hex_learning_memo_readable(name)));
drop policy if exists ai_field_memos_read_boundary on storage.objects;
create policy ai_field_memos_read_boundary on storage.objects as restrictive for select to authenticated using (
  bucket_id <> 'ai-field-memos' or (not public.is_partner_user() and (
    (public.custom_work_internal() and (split_part(name, '/', 1) = auth.uid()::text or public._is_supervisor(auth.uid())))
    or public.hex_learning_memo_readable(name))));

-- ---------------------------------------------------------------------------
-- 10. Crew announcement
-- ---------------------------------------------------------------------------
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-23-learning-review','2026-09-23',array[0,1,2,3],'improvement',
 'Write up job lessons and send them for review','Escribe lecciones del trabajo y envíalas a revisión',
 'Tell Ask what happened, or open a saved Hex-Portal case, and fill in Issue, What happened, Impact, Lesson learned and Preventive action. Mark anything you do not know as Unknown. Choose a foreman or supervisor by name and tap Send. A foreman can ask for changes or pass it to a supervisor; only a supervisor or owner approves it for the Hex-Portal archive. Approval is not a new installation instruction, and your time and pay are never changed.',
 'Cuéntale a Ask lo que pasó, o abre un caso guardado de Hex-Portal, y completa Problema, Qué pasó, Impacto, Lección aprendida y Acción preventiva. Marca como Desconocido lo que no sepas. Elige a un capataz o supervisor por nombre y toca Enviar. Un capataz puede pedir cambios o pasarlo a un supervisor; solo un supervisor o dueño lo aprueba para el archivo de Hex-Portal. La aprobación no es una nueva instrucción de instalación, y tu tiempo y pago nunca cambian.','/ask') on conflict(id) do nothing;

-- ---------------------------------------------------------------------------
-- 10. Registrations: person removal counts, sandbox fence
-- ---------------------------------------------------------------------------
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

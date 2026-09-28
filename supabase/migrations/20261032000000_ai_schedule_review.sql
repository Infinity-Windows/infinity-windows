-- K2.8 of the crew redesign (Release 2, "the AI"): the supervisor's review of
-- what Forge AI drafted on Scheduling.
--
-- 1. WHERE THE AI'S REASON LIVES. Every draft the assistant's draft_assignments
--    tool writes carries one plain sentence — why this person, this job, this
--    day — that a supervisor reads on the Review AI drafts card before
--    publishing. It is reasoning about PEOPLE ("keeps Team 1 together", "Ben
--    is the second pair of hands"), so it must never reach the crew. The first
--    cut stored it on the draft's 'created' schedule_events payload, but that
--    table's read policy (20261003000000, "schedule events internal read")
--    lets EVERY non-partner login read every row — the card's supervisor
--    gate was only ever in the UI, and Codex's review of #646 reproduced an
--    installer reading the reason straight off REST. So the reason gets its
--    own table with the boundary in the database: SELECT for supervisors
--    and owners only, INSERT for the same people on their own AI drafts,
--    nothing for anyone else. schedule_events keeps its {ai: true} audit mark
--    and nothing more.
--
-- 2. THE ANNOUNCEMENT, for ranks 2 and 3 alone — installers and foremen never
--    see the card and are not told about it (docs/app-updates.md).

-- ---------------------------------------------------------------------------
-- 1. The reason, behind a supervisor-only wall
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_ai_reasons (
  -- One reason per draft; the row goes when the draft goes (Drop is the
  -- board's own delete, and schedule_assignment_members cascades the same way).
  assignment_id uuid primary key references public.schedule_assignments(id) on delete cascade,
  -- The tool trims and clips at 160 (schedulingTools.ts MAX_DRAFT_REASON_CHARS);
  -- the check is the same number so a longer sentence cannot arrive by any
  -- other door.
  reason text not null check (length(btrim(reason)) between 1 and 160),
  -- The supervisor whose Ask session drafted it. Set null, never cascade: a
  -- retired login does not take the reason with it (schedule_events.actor
  -- is kept the same way).
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.schedule_ai_reasons is
  'Why Forge AI put this person on this job this day (K2.8) — one sentence per AI draft, readable by supervisors and owners only. Never crew-visible: it reasons about people. Written by the Ask draft_assignments executor on the drafting supervisor''s own session; cascades away with the draft.';

alter table public.schedule_ai_reasons enable row level security;
revoke all on public.schedule_ai_reasons from public, anon, authenticated;
grant select, insert on public.schedule_ai_reasons to authenticated;

-- Readers: an active supervisor or owner who is not a partner login. The
-- partner guard is THE WALL's rule for every crew-readable table (20260950);
-- travel_is_supervisor() is the same rank check the schedule tables' own
-- write policies use (20261003000000).
drop policy if exists schedule_ai_reasons_supervisor_read on public.schedule_ai_reasons;
create policy schedule_ai_reasons_supervisor_read on public.schedule_ai_reasons
  for select to authenticated
  using (not public.is_partner_user() and public.travel_is_supervisor());

-- Writers: the same people, for a reason they are recording themselves, on a
-- row that IS an AI draft. The Ask function's executor runs on the caller's
-- own scoped client (supabase/functions/ask/index.ts, executeDraftAssignments),
-- so this policy is what it passes through; a supervisor drafts schedules
-- and nobody below that rank can reach draft_assignments at all. No update
-- and no delete: a reason is written once with its draft and leaves with it.
drop policy if exists schedule_ai_reasons_supervisor_write on public.schedule_ai_reasons;
create policy schedule_ai_reasons_supervisor_write on public.schedule_ai_reasons
  for insert to authenticated
  with check (
    not public.is_partner_user()
    and public.travel_is_supervisor()
    and created_by = auth.uid()
    and exists (
      select 1 from public.schedule_assignments a
      where a.id = assignment_id and a.created_via = 'ai'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. The announcement
-- ---------------------------------------------------------------------------
-- Supervisor and owner announcement: the Review AI drafts card on Scheduling,
-- with the reason Forge AI now gives for each draft row, and the publish sheet
-- saying so when a publish is refused. A supervisor-only control gets its own
-- announcement (docs/app-updates.md): the audience is ranks 2 and 3 alone.
-- created_via (20260955010000) is the flag the card reads.
insert into public.app_release_notes(id,published_on,audience,kind,title_en,title_es,body_en,body_es,href) values
('2026-09-24-ai-schedule-review','2026-09-24',array[2,3],'improvement',
 'Review what Forge AI drafted before you publish','Revisa lo que Forge AI propuso antes de publicar',
 'Scheduling now has a Review AI drafts card: every draft the AI wrote, with its reason for that person on that job that day. Keep or drop each one, then publish the way you always have — nothing reaches the crew until you publish. If a publish is refused, the sheet now says so instead of staying quiet.',
 'Programación tiene ahora una tarjeta Revisar borradores de la IA: cada borrador que escribió la IA, con su motivo para esa persona en esa obra ese día. Conserva o descarta cada uno y luego publica como siempre; nada llega al equipo hasta que publiques. Si una publicación es rechazada, ahora la hoja lo dice en vez de quedarse callada.',
 '/scheduling') on conflict(id) do nothing;

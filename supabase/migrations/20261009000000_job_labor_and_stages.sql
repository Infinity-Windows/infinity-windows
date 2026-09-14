-- Whole-job labor targets are internal, separate from the existing install estimate.
begin;
create table public.project_labor_targets (
  project_id uuid primary key references public.projects(id) on delete cascade,
  projected_hours numeric check (projected_hours > 0 and projected_hours < 10000000),
  goal_hours numeric check (goal_hours > 0 and goal_hours < 10000000),
  square_feet numeric check (square_feet > 0 and square_feet < 1000000000),
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
create table public.project_stage_progress (
  project_id uuid references public.projects(id) on delete cascade,
  stage_key text not null check (stage_key in ('material_delivered','material_onsite','ros_checked','ros_flashed','frames_set','glass_doors_installed','hardware_installed','detail_work','qc_passed','customer_approved')),
  completed boolean not null default false,
  note text not null default '',
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (project_id, stage_key)
);
create table public.project_execution_history (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  event_kind text not null,
  before_value jsonb,
  after_value jsonb not null,
  reason text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.project_labor_targets enable row level security;
alter table public.project_stage_progress enable row level security;
alter table public.project_execution_history enable row level security;
revoke all on public.project_labor_targets from public, anon, authenticated;
revoke all on public.project_stage_progress from public, anon, authenticated;
revoke all on public.project_execution_history from public, anon, authenticated;
grant select on public.project_labor_targets to authenticated;
grant select on public.project_stage_progress to authenticated;
grant select on public.project_execution_history to authenticated;

create policy labor_targets_read on public.project_labor_targets for select to authenticated
using (not public.is_partner_user() and public._is_lead(auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.deleted_at is null));
create policy stage_progress_read on public.project_stage_progress for select to authenticated
using (not public.is_partner_user() and public._is_lead(auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.deleted_at is null));
create policy execution_history_read on public.project_execution_history for select to authenticated
using (not public.is_partner_user() and public._is_lead(auth.uid()) and exists (select 1 from public.projects p where p.id = project_id and p.deleted_at is null));

create or replace function public.set_project_labor_targets(
  p_project_id uuid, p_projected_hours numeric, p_goal_hours numeric,
  p_square_feet numeric, p_revision integer, p_reason text
) returns public.project_labor_targets
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.project_labor_targets; v_new public.project_labor_targets;
begin
  if auth.uid() is null or public.is_partner_user() or not exists (
    select 1 from public.profiles where id = auth.uid() and role in ('supervisor','owner','admin','big_boss')
  ) then raise exception 'Only supervisors and owners can edit labor targets.'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 2000 then
    raise exception 'Please give a short reason for this change.';
  end if;
  -- Lock the parent even on the first save, so two new-target forms cannot both win.
  perform 1 from public.projects where id = p_project_id and deleted_at is null for update;
  if not found then raise exception 'That job is unavailable.'; end if;
  select * into v_old from public.project_labor_targets where project_id = p_project_id;
  if p_revision is null or p_revision <> coalesce(v_old.revision, 0) then
    raise exception 'Labor targets changed. Refresh before saving.';
  end if;
  insert into public.project_labor_targets(project_id, projected_hours, goal_hours, square_feet, revision, updated_by)
  values (p_project_id, p_projected_hours, p_goal_hours, p_square_feet, p_revision + 1, auth.uid())
  on conflict (project_id) do update set projected_hours = excluded.projected_hours,
    goal_hours = excluded.goal_hours, square_feet = excluded.square_feet,
    revision = excluded.revision, updated_at = now(), updated_by = auth.uid()
  returning * into v_new;
  insert into public.project_execution_history(project_id,event_kind,before_value,after_value,reason,actor_id)
  values (p_project_id,'labor_targets',to_jsonb(v_old),to_jsonb(v_new),btrim(p_reason),auth.uid());
  return v_new;
end; $$;
revoke all on function public.set_project_labor_targets(uuid,numeric,numeric,numeric,integer,text) from public, anon;
grant execute on function public.set_project_labor_targets(uuid,numeric,numeric,numeric,integer,text) to authenticated;

create or replace function public.set_project_stage(
  p_project_id uuid, p_stage_key text, p_completed boolean, p_note text, p_revision integer
) returns public.project_stage_progress
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.project_stage_progress; v_new public.project_stage_progress;
begin
  if auth.uid() is null or public.is_partner_user() or not public._is_lead(auth.uid()) then
    raise exception 'Only foremen and above can update job stages.';
  end if;
  if p_completed is null or p_note is null or length(btrim(p_note)) < 3 or length(p_note) > 2000 then
    raise exception 'Add a short completion note or reopening reason.';
  end if;
  perform 1 from public.projects where id = p_project_id and deleted_at is null for update;
  if not found then raise exception 'That job is unavailable.'; end if;
  select * into v_old from public.project_stage_progress where project_id = p_project_id and stage_key = p_stage_key;
  if p_revision is null or p_revision <> coalesce(v_old.revision, 0) then
    raise exception 'This stage changed. Refresh before saving.';
  end if;
  insert into public.project_stage_progress(project_id,stage_key,completed,note,revision,updated_by)
  values (p_project_id,p_stage_key,p_completed,btrim(p_note),p_revision+1,auth.uid())
  on conflict (project_id,stage_key) do update set completed = excluded.completed,
    note = excluded.note, revision = excluded.revision, updated_at = now(), updated_by = auth.uid()
  returning * into v_new;
  insert into public.project_execution_history(project_id,event_kind,before_value,after_value,reason,actor_id)
  values (p_project_id,'stage:' || p_stage_key,to_jsonb(v_old),to_jsonb(v_new),btrim(p_note),auth.uid());
  return v_new;
end; $$;
revoke all on function public.set_project_stage(uuid,text,boolean,text,integer) from public, anon;
grant execute on function public.set_project_stage(uuid,text,boolean,text,integer) to authenticated;
-- Arm the existing QA-login fence on these new job-scoped tables as well.
select public.attach_sandbox_guards();
commit;

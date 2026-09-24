-- A stand-in for a pull request's migration: a table with a check constraint
-- the local tests would not have had, and a SECURITY DEFINER RPC that writes
-- to it as the caller. Wrapped in begin/commit on purpose, like fourteen
-- migrations on master, so the harness test proves the wrapper is set aside
-- on a real Postgres and not only in the unit tests.
begin;

create table public.demo_notes (
  id serial primary key,
  author uuid not null references public.profiles(id),
  project_id uuid not null references public.projects(id),
  body text not null,
  constraint demo_notes_body_short_ck check (length(body) <= 20)
);
alter table public.demo_notes enable row level security;
revoke all on public.demo_notes from public, anon, authenticated;

create function public.demo_leave_note(p_project uuid, p_body text) returns public.demo_notes
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.demo_notes;
begin
  if auth.uid() is null then
    raise exception 'Sign in before leaving a note.' using errcode = '42501';
  end if;
  insert into public.demo_notes (author, project_id, body) values (auth.uid(), p_project, p_body)
  returning * into v;
  return v;
end $$;
revoke all on function public.demo_leave_note(uuid, text) from public, anon;
grant execute on function public.demo_leave_note(uuid, text) to authenticated;

commit;

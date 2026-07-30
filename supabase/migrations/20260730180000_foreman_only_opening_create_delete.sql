-- Only a foreman or above may add or remove a window or door on a job.
--
-- 20260730160000 stopped installers MOVING a mark. Two sharper edges were left
-- open and are closed here, both at Taylor's call:
--
--   * "Load marks from plans" — re-reading a planset. This is the highest-
--     consequence button in the app. A bug in this exact path could destroy
--     field work through ON DELETE CASCADE plus a flawed guard; PR #132 fixed
--     that by refusing to delete any opening that carries field work. This
--     migration is defence in depth ON TOP of that, about WHO may run it. It
--     does not replace, weaken or duplicate #132's rule about WHAT may be
--     deleted, which still runs client-side in planDraftPersistence.
--
--   * Deleting an opening. install_events references project_openings ON DELETE
--     CASCADE, so removing an opening takes its install history with it.
--
-- HOW THE ACT IS SCOPED, AND WHY IT IS NOT A PIN GUARD
--
-- Re-extraction is exactly two statements: a DELETE of the superseded openings
-- and an INSERT of the fresh ones. There is no third thing to catch, so
-- guarding who may INSERT or DELETE an opening IS guarding who may re-extract.
-- No heuristic, no sniffing at the payload.
--
-- That is deliberately NOT the guard 20260730160000 declined to add. The naive
-- move would have been to extend the pin guard to INSERT — refusing a row
-- BECAUSE IT CARRIES A PIN. That keys on the shape of the row, and it breaks
-- extraction itself, whose whole job is to insert already-pinned rows. This
-- guard keys on the ACTOR and ignores the row completely: a foreman's extract
-- inserts pinned rows exactly as before.
--
-- WHY NOTHING THE CREW DOES BREAKS
--
-- Nothing an installer does creates or removes an opening. Openings are created
-- in two places, both behind foreman-only routes or controls:
--
--   saveDraftOpenings  planset upload (/projects/:id/upload, RequireRole
--                      foreman) and "Load marks from plans" on the map, which
--                      this PR hides below foreman
--   addOpening         the openings review screen (/projects/:id/review,
--                      RequireRole foreman) and the plan editor, already
--                      foreman-only since 20260730160000
--
-- and removed in two, the same two. Every installer write goes through a
-- security-definer RPC that only ever UPDATEs columns — claim, start, finish,
-- measure, condition, flag, assignment. The edge functions only ever SELECT
-- from this table. No outbox operation creates or deletes an opening, so there
-- is nothing queued in a dead zone that this can turn into a failure.
--
-- CASCADES
--
-- A BEFORE DELETE row trigger fires for cascaded deletes too, so this is worth
-- being explicit about. project_openings.project_id is ON DELETE CASCADE from
-- projects, but nothing in the app deletes a project; the only caller would be
-- a migration or an admin script, which has no JWT and is exempt below.
-- planset_id is ON DELETE SET NULL, so retiring a planset never reaches here.

create or replace function public.guard_opening_create_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row project_openings;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;

  -- No JWT means this is not a person holding a phone: a migration, or an edge
  -- function on the service key. Both are already trusted above RLS, and the
  -- anon role cannot reach this table at all — the only policy on it is granted
  -- `to authenticated`.
  if auth.uid() is null then
    return v_row;
  end if;

  if not public.is_foreman_plus(auth.uid()) then
    -- Plain English, because these sentences are shown to the crew verbatim.
    if tg_op = 'DELETE' then
      raise exception 'Only a foreman or above can remove a window or door from a job.'
        using errcode = '42501';
    else
      raise exception 'Only a foreman or above can add windows or doors to a job.'
        using errcode = '42501';
    end if;
  end if;

  return v_row;
end;
$$;

-- Fires before `seed_opening_origin_pin` on INSERT (Postgres runs BEFORE row
-- triggers in name order, and g sorts before s), so a refused insert never
-- reaches the origin-seeding logic.
drop trigger if exists guard_opening_create_delete on project_openings;
create trigger guard_opening_create_delete
  before insert or delete on project_openings
  for each row execute function public.guard_opening_create_delete();

comment on function public.guard_opening_create_delete() is
  'Refuses creating or removing an opening from anyone below foreman, which is what makes re-reading a planset foreman-only. Says nothing about WHICH rows may go — that is planDraftPersistence, from PR #132.';

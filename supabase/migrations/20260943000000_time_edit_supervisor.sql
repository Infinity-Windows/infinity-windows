-- Wave T, T2: edit everything, with a name on every edit.
--
-- Two settled decisions from the T1 spec's grill apply here, and this
-- migration is what changes to satisfy them:
--
--   Q3. Timecard edit/void: supervisor+ only; foremen read-only.
--   Q4. Editing an approved shift RESETS its approval; if the editor could
--       have approved it, the same save re-approves — no busywork.
--
-- `lead_edit_shift` (20260718050000, last redefined 20260810000000) already
-- does almost all of this, gated at foreman+ (`_is_lead`) and always
-- dropping an approved shift to 'submitted'. `edit_shift` below is its
-- replacement: same shape, `_is_supervisor` gate (Q3), and the self-
-- reapprove rule (Q4). `lead_edit_shift` is left in place, unused by the
-- client after this lands, rather than dropped — no other caller of it was
-- found, but dropping a function some other integration might still hit
-- is a needless risk for zero benefit.
--
-- Scope note for the reviewer: Q3's "foremen read-only" is applied here
-- only to edit and void (T3) — the two actions this wave's grill actually
-- named and the two T-items that touch payroll numbers after the fact.
-- `lead_add_shift` (adding a missing punch), `reject_shift`, `approve_shift`
-- and `close_shift_as_no_work` are UNCHANGED, still foreman+. If the intent
-- was broader ("foremen lose every write action on a timecard"), say so and
-- it's a small follow-up — narrowing it silently beyond what was actually
-- decided felt like the wrong default.
--
-- Note also: time_shifts already has edited_by/edited_at (20260730230000) —
-- T2 asked for the columns "to gain" them, but they were already there, so
-- no column changes are needed, only the RPC.

create or replace function edit_shift(
  p_shift_id uuid,
  p_project_id uuid default null,
  p_cost_code_id uuid default null,
  p_clock_in_at timestamptz default null,
  p_clock_out_at timestamptz default null,
  p_break_seconds int default null,
  p_note text default null
)
returns time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old time_shifts;
  v_shift time_shifts;
  -- Q4: "if the editor could have approved it" — approve_shift's own gate is
  -- "not an installer", which is exactly what _is_lead means. edit_shift
  -- already requires _is_supervisor (a strict subset of _is_lead), so this
  -- is always true today; kept as an explicit check rather than a constant
  -- so the two rules stay independently correct if they ever diverge.
  v_could_approve boolean;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'only a supervisor or above can edit crew time';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'an edit needs a reason note';
  end if;

  select * into v_old from time_shifts where id = p_shift_id for update;
  if v_old is null then raise exception 'no shift %', p_shift_id; end if;

  v_could_approve := _is_lead(auth.uid());

  update time_shifts
     set project_id    = coalesce(p_project_id, project_id),
         cost_code_id  = coalesce(p_cost_code_id, cost_code_id),
         clock_in_at   = coalesce(p_clock_in_at, clock_in_at),
         clock_out_at  = coalesce(p_clock_out_at, clock_out_at),
         break_seconds = coalesce(p_break_seconds, break_seconds),
         edited_note   = p_note,
         edited_by     = auth.uid(),
         edited_at     = now(),
         status        = case
                           when v_old.status = 'approved' and v_could_approve
                             then 'approved'
                           when v_old.status = 'approved'
                             then 'submitted'
                           when p_clock_out_at is not null
                                and v_old.status in ('open', 'needs_finish')
                             then 'submitted'
                           else v_old.status
                         end,
         approved_by   = case
                           when v_old.status = 'approved' and v_could_approve
                             then auth.uid()
                           when v_old.status = 'approved'
                             then null
                           else approved_by
                         end,
         approved_at   = case
                           when v_old.status = 'approved' and v_could_approve
                             then now()
                           when v_old.status = 'approved'
                             then null
                           else approved_at
                         end
   where id = p_shift_id
   returning * into v_shift;

  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  select p_shift_id, auth.uid(), d.field, d.old_value, d.new_value, btrim(p_note)
  from (values
    ('project_id',    v_old.project_id::text,    v_shift.project_id::text),
    ('cost_code_id',  v_old.cost_code_id::text,  v_shift.cost_code_id::text),
    ('clock_in_at',   v_old.clock_in_at::text,   v_shift.clock_in_at::text),
    ('clock_out_at',  v_old.clock_out_at::text,  v_shift.clock_out_at::text),
    ('break_seconds', v_old.break_seconds::text, v_shift.break_seconds::text),
    ('status',        v_old.status,              v_shift.status)
  ) as d(field, old_value, new_value)
  where d.old_value is distinct from d.new_value;

  return v_shift;
end;
$$;

revoke all on function edit_shift(uuid, uuid, uuid, timestamptz, timestamptz, int, text) from public;
grant execute on function edit_shift(uuid, uuid, uuid, timestamptz, timestamptz, int, text) to authenticated;

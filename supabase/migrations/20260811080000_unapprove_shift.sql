-- Un-approving an approved punch (owner call, 2026-08-11).
--
-- Approvals get an escape hatch that is NOT a quiet edit: a supervisor+
-- can revert an approved punch back to 'submitted' with a REQUIRED reason.
-- The hours don't change; only the approval is taken back. The reason goes
-- three places: the append-only audit trail (supervisor-readable), the
-- edited_note stamp (so the crew member's own timecard can show WHY until
-- re-approval), and the client push notification.
--
-- Deliberately supervisor+, not foreman: foremen approve, but taking an
-- approval back is an office call — one deliberate step of friction.

create or replace function lead_unapprove_shift(p_shift_id uuid, p_note text)
returns time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old time_shifts;
  v_shift time_shifts;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'only a supervisor or above can revert an approval';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'reverting an approval needs a reason note';
  end if;

  select * into v_old from time_shifts where id = p_shift_id for update;
  if v_old is null then raise exception 'no shift %', p_shift_id; end if;
  if v_old.status <> 'approved' then
    raise exception 'this punch is not approved';
  end if;

  update time_shifts
     set status      = 'submitted',
         approved_by = null,
         approved_at = null,
         edited_note = 'Approval reverted: ' || btrim(p_note),
         edited_by   = auth.uid(),
         edited_at   = now()
   where id = p_shift_id
   returning * into v_shift;

  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (p_shift_id, auth.uid(), 'status', 'approved', 'submitted', btrim(p_note));

  return v_shift;
end;
$$;

revoke all on function lead_unapprove_shift(uuid, text) from public;
grant execute on function lead_unapprove_shift(uuid, text) to authenticated;

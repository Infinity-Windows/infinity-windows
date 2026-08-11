-- Deleting a timecard punch (owner call, 2026-08-11).
--
-- The edit sheet gets a delete option — but payroll truth is never erased.
-- Deleting VOIDS the shift: status 'voided' takes it out of every timecard
-- list, total, overtime split and export, while the row itself and a
-- permanent audit entry (who, when, why) stay behind. Same instinct as the
-- install undo: void, never delete.
--
-- Same discipline as lead_edit_shift: foreman+ only, reason required,
-- logged per-field to time_shift_edits by the security-definer RPC (no
-- client write path), approval cleared because a voided shift must never
-- ride through payroll approved.

-- 1) 'voided' becomes a legal status ----------------------------------------

alter table time_shifts drop constraint if exists time_shifts_status_check;
alter table time_shifts
  add constraint time_shifts_status_check
  check (status in ('open', 'submitted', 'approved', 'rejected', 'needs_finish', 'voided'));

-- 2) lead_void_shift --------------------------------------------------------

create or replace function lead_void_shift(p_shift_id uuid, p_note text)
returns time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old time_shifts;
  v_shift time_shifts;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can delete crew time';
  end if;
  if p_note is null or btrim(p_note) = '' then
    raise exception 'deleting a punch needs a reason note';
  end if;

  select * into v_old from time_shifts where id = p_shift_id for update;
  if v_old is null then raise exception 'no shift %', p_shift_id; end if;
  if v_old.status = 'voided' then
    raise exception 'this punch is already deleted';
  end if;

  update time_shifts
     set status      = 'voided',
         edited_note = btrim(p_note),
         edited_by   = auth.uid(),
         edited_at   = now(),
         approved_by = null,
         approved_at = null
   where id = p_shift_id
   returning * into v_shift;

  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (p_shift_id, auth.uid(), 'status', v_old.status, 'voided', btrim(p_note));

  return v_shift;
end;
$$;

revoke all on function lead_void_shift(uuid, text) from public;
grant execute on function lead_void_shift(uuid, text) to authenticated;

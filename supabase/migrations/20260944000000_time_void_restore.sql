-- Wave T, T3: void with reason + Undo.
--
-- Settled decision (T1 spec): "'Void' is the word for deleting a punch:
-- sets voided_at/by/reason, never deletes the row. Hard delete = owner-only
-- purge, separate door." That is a schema change from what already existed:
-- `lead_void_shift` (20260811060000) voided a shift by overloading
-- status='voided' + the edit trio (edited_by/edited_at/edited_note) it
-- shares with ordinary edits — which meant a punch that was both edited
-- and later voided left only one note field to say which reason was which.
-- `void_shift` below gives void its own columns, entirely separate from the
-- edit trio, and pairs with a new `restore_shift` (Undo). `lead_void_shift`
-- is left in place, unused, same reasoning as `lead_edit_shift` in T2's
-- migration: no other caller was found, and dropping it is a needless risk
-- for zero benefit.
--
-- Also settled: void/restore are supervisor+ (Q3), same as edit.

alter table time_shifts
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references profiles(id) on delete set null,
  add column if not exists voided_reason text;

-- ---------------------------------------------------------------- void_shift

create or replace function void_shift(p_shift_id uuid, p_reason text)
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
    raise exception 'only a supervisor or above can delete crew time';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'deleting a punch needs a reason';
  end if;

  select * into v_old from time_shifts where id = p_shift_id for update;
  if v_old is null then raise exception 'no shift %', p_shift_id; end if;
  if v_old.status = 'voided' then
    raise exception 'this punch is already deleted';
  end if;

  update time_shifts
     set status        = 'voided',
         voided_at     = now(),
         voided_by     = auth.uid(),
         voided_reason = btrim(p_reason),
         approved_by   = null,
         approved_at   = null
   where id = p_shift_id
   returning * into v_shift;

  -- The Horizon fake-success lesson, cited per the spec: an UPDATE that
  -- matches nothing (RLS silently excluded the row, or it moved under us)
  -- must never be reported back as though the void happened. Belt-and-
  -- suspenders alongside the `for update` row lock above, which already
  -- makes this unreachable today — kept explicit so a future refactor that
  -- drops the lock still fails loudly instead of lying. (This exact phrase
  -- isn't written down anywhere else in this repo that a search could find;
  -- recording the reasoning here rather than a citation I can't verify.)
  if v_shift.id is null then
    raise exception 'void did not apply to shift % — no row was updated', p_shift_id;
  end if;

  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (p_shift_id, auth.uid(), 'status', v_old.status, 'voided', btrim(p_reason));

  return v_shift;
end;
$$;

revoke all on function void_shift(uuid, text) from public;
grant execute on function void_shift(uuid, text) to authenticated;

-- ------------------------------------------------------------- restore_shift
-- The 5-second Undo toast's inverse, and the "Show removed" list's Restore
-- button — same RPC either way, just called at different times.
--
-- Never resurrects the old approval: same reasoning as edit_shift dropping
-- an approved shift to 'submitted' when the editor couldn't have re-approved
-- it (Q4's sibling rule) — the approval was given to a world where this
-- punch was voided; a person re-approves the restored punch fresh. The
-- restored status is read off the row's own shape (closed vs. still open)
-- rather than replayed from the audit log, so there is nothing to parse and
-- nothing that can drift from what the row actually looks like now.

create or replace function restore_shift(p_shift_id uuid)
returns time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old time_shifts;
  v_shift time_shifts;
  v_restored_status text;
begin
  if not _is_supervisor(auth.uid()) then
    raise exception 'only a supervisor or above can restore crew time';
  end if;

  select * into v_old from time_shifts where id = p_shift_id for update;
  if v_old is null then raise exception 'no shift %', p_shift_id; end if;
  if v_old.status <> 'voided' then
    raise exception 'this punch is not deleted';
  end if;

  v_restored_status := case when v_old.clock_out_at is not null then 'submitted' else 'open' end;

  update time_shifts
     set status        = v_restored_status,
         voided_at     = null,
         voided_by     = null,
         voided_reason = null,
         approved_by   = null,
         approved_at   = null
   where id = p_shift_id
   returning * into v_shift;

  if v_shift.id is null then
    raise exception 'restore did not apply to shift % — no row was updated', p_shift_id;
  end if;

  insert into time_shift_edits (shift_id, edited_by, field, old_value, new_value, reason)
  values (p_shift_id, auth.uid(), 'status', 'voided', v_restored_status, 'restored');

  return v_shift;
end;
$$;

revoke all on function restore_shift(uuid) from public;
grant execute on function restore_shift(uuid) to authenticated;

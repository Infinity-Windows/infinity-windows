-- Record a runaway shift as no work done, at zero hours, with a reason.
--
-- 20260730230000 gave the app a way to stop counting a shift that ran past the
-- believable maximum, and `finish_shift_at` for when somebody can say what time
-- they really stopped. It deliberately refuses a finish time that is not after
-- the clock-in, so there was no way to record the other true answer: that no
-- work happened at all and the punch should stand at zero.
--
-- That was the missing half. Without it the only ways to clear a runaway shift
-- were to invent a finish time or to delete the row, and both destroy the
-- record of what actually happened. This closes it at zero and says who decided
-- that and why.
--
-- Ammon's 18 July punch on PECAN14 is the first case, and Taylor's decision on
-- 30 July 2026 was that it was app testing during the build rather than worked
-- time. It is applied at the bottom of this file.

-- 1) The RPC, so a foreman can do this from the timecard screen -------------
-- Lead-level only: writing a shift off to zero is a payroll decision, not
-- something the person whose shift it is should do for themselves.
--
-- Zero hours is achieved by closing at the clock-in moment, which is the only
-- honest way to say "this punch represents no work" while keeping the punch
-- itself. `shiftHours()` in the app and `computeLabor()` in job costing both
-- measure clock_out minus clock_in, so both come out at exactly zero.
--
-- It lands as 'approved' rather than 'submitted' on purpose: this IS the
-- decision, so it must not then appear in somebody's approvals queue as a
-- question still to answer.

create or replace function close_shift_as_no_work(
  p_shift_id uuid,
  p_reason text default null
)
returns time_shifts
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_shift time_shifts;
begin
  if not _is_lead(auth.uid()) then
    raise exception 'only a lead-level user can write a shift off to zero';
  end if;

  select * into v_shift from time_shifts where id = p_shift_id;
  if v_shift.id is null then
    raise exception 'no shift %', p_shift_id;
  end if;
  if v_shift.clock_out_at is not null then
    raise exception 'that shift is already closed';
  end if;

  update time_shifts
     set clock_out_at  = clock_in_at,
         break_seconds = 0,
         break_started_at = null,
         break_type    = null,
         -- The worker never signed off on this, a supervisor decided it.
         time_confirmed = false,
         injured       = coalesce(injured, false),
         signed_at     = now(),
         status        = 'approved',
         edited_by     = auth.uid(),
         edited_at     = now(),
         approved_by   = auth.uid(),
         approved_at   = now(),
         edited_note   = left(
           coalesce(edited_note || ' | ', '') ||
           'Recorded as zero hours — no work was done on this punch.' ||
           coalesce(' Reason: ' || nullif(btrim(p_reason), ''), ''),
           2000)
   where id = p_shift_id
  returning * into v_shift;

  return v_shift;
end;
$$;

revoke all on function close_shift_as_no_work(uuid, text) from public;
grant execute on function close_shift_as_no_work(uuid, text) to authenticated;

-- 2) Taylor's decision on the one shift that exists ------------------------
-- The only row `time_shifts` has ever held on production: Ammon punched into
-- PECAN14 on 2026-07-18 20:31:26Z while the app was being built and never
-- punched out, which is what produced the "WORKING 286:57:59" Taylor asked
-- about. He confirmed on 2026-07-30 that it was not worked time.
--
-- Done as a statement rather than through the RPC above because the RPC reads
-- `auth.uid()` for the audit fields and a migration has no signed-in user; the
-- decision-maker is therefore named explicitly instead. Scoped to the single id
-- and guarded on the row still being open, so re-running changes nothing.

do $$
declare
  -- Taylor, role 'owner'. He is the person who made this call.
  v_taylor uuid := '958d3bfc-946e-46b3-a84c-a84d5f586a2e';
  v_shift  uuid := 'd59b9c5a-f500-41b8-bae3-337e46dd8e58';
  v_rows   int;
begin
  if not exists (select 1 from profiles where id = v_taylor) then
    raise notice 'skipping: profile % not found on this database', v_taylor;
    return;
  end if;

  update time_shifts
     set clock_out_at  = clock_in_at,
         break_seconds = 0,
         break_started_at = null,
         break_type    = null,
         time_confirmed = false,
         injured       = coalesce(injured, false),
         signed_at     = now(),
         status        = 'approved',
         edited_by     = v_taylor,
         edited_at     = now(),
         approved_by   = v_taylor,
         approved_at   = now(),
         edited_note   = left(
           coalesce(edited_note || ' | ', '') ||
           'Recorded as zero hours by Taylor on 2026-07-30: this punch was '
           || 'Ammon testing the app while it was being built, not worked time. '
           || 'The shift is kept for the record and counts as no hours anywhere.',
           2000)
   where id = v_shift
     and clock_out_at is null;

  get diagnostics v_rows = row_count;
  raise notice 'closed % runaway shift(s) as no work done', v_rows;
end;
$$;

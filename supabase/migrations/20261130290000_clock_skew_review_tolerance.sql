-- Stop marking an activity "Needs review" for the gap between two clocks.
--
-- A person in an activity taps Clock out. The phone ends the activity and the
-- shift at the same tap, but the two reach the database in different clocks:
-- the activity's end is the phone's own time (custom_work_command reads
-- p_data->>'at' as sent), while the shift's end is that tap corrected into the
-- server's clock (_clock_pick_time subtracts the phone's measured skew, or
-- uses arrival when the tap is not trusted). On any phone running even a
-- little ahead, the activity therefore "ended after" the shift by the size of
-- the skew, and the rule below flagged the last activity of the day for review
-- although nothing was wrong with it (Matt's test shifts of 2026-11-22: only
-- the activity still running at clock-out was flagged, on a submitted shift
-- for the same job with no break). The same gap exists at clock-in for a phone
-- running behind.
--
-- _clock_pick_time trusts a phone whose clock is within 2 minutes of the
-- server's, so 2 minutes is the most these two times can honestly differ by.
-- Inside that the activity is left alone; past it the review mark stands, as
-- it does for a different job or a shift that needs finishing. Times are not
-- rewritten: only what counts as a discrepancy changes. Activities already
-- marked keep their mark until someone checks them.
create or replace function public.custom_work_follow_shift() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  finish_at timestamptz;
  clock_gap constant interval := interval '2 minutes';
begin
  update public.custom_work_sessions set shift_status=new.status,
    review_required=review_required or new.status in ('needs_finish','rejected','voided') or project_id is distinct from new.project_id
      or started_at<new.clock_in_at-clock_gap
      or (ended_at is not null and new.clock_out_at is not null and ended_at>new.clock_out_at+clock_gap)
    where shift_id=new.id;
  finish_at:=coalesce(new.clock_out_at,new.break_started_at);
  if finish_at is null and new.status<>'open' then finish_at:=now(); end if;
  if finish_at is not null then
    update public.custom_work_sessions set review_required=review_required or started_at>finish_at+clock_gap,ended_at=greatest(started_at,finish_at),end_reason=case when new.break_started_at is not null and new.clock_out_at is null then 'break' when new.status in ('needs_finish','rejected','voided') then 'needs_review' else 'clock_out' end,revision=revision+1 where shift_id=new.id and ended_at is null;
  end if;
  return new;
end; $$;

revoke all on function public.custom_work_follow_shift() from public,anon,authenticated;

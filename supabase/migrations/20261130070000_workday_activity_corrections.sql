-- Keep the existing session command and audit ledger. A correction of a
-- closed activity can reverse the Workday done mark. Delayed timer metadata
-- captured before that correction cannot restore the superseded outcome.
alter table public.custom_work_sessions
  add column if not exists workday_outcome_corrected_at timestamptz;

create function public._workday_respect_session_correction() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.ended_at is not null and new.revision > old.revision
      and new.outcome is distinct from old.outcome then
    new.workday_outcome_corrected_at := clock_timestamp();
    if new.outcome is distinct from 'finished' then
      new.workday_done_at := null;
    end if;
  elsif new.workday_done_at is distinct from old.workday_done_at
      and new.workday_done_at <= old.workday_outcome_corrected_at then
    new.workday_done_at := old.workday_done_at;
    new.outcome := old.outcome;
  end if;
  if old.ended_at is not null and new.revision > old.revision
      and new.description is distinct from old.description then
    new.workday_note_changed_at := greatest(old.workday_note_changed_at, clock_timestamp());
  end if;
  return new;
end;
$$;

-- Runs after workday_close_session, which derives outcome from a done tap.
create trigger workday_respect_session_correction
before update on public.custom_work_sessions
for each row execute function public._workday_respect_session_correction();

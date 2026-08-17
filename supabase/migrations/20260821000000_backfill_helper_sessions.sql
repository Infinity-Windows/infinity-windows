-- One-time backfill (sessions ticket 04): historical Summon helper stints
-- become helper sessions, so no evidence is lost to the cutover. The
-- glossary already says a helper's stint IS a session; this makes the
-- rows that predate unit_sessions say so too. Idempotent: a row is only
-- inserted when no helper session with the same person/unit/start exists
-- (the trigger from 20260820000000 writes new ones going forward).

insert into unit_sessions (opening_id, profile_id, role, is_rework, started_at, ended_at, end_reason)
select s.opening_id, h.profile_id, 'helper', false, h.joined_at, h.completed_at, 'complete'
from summon_helpers h
join summons s on s.id = h.summon_id
where h.completed_at is not null
  and not exists (
    select 1 from unit_sessions us
    where us.profile_id = h.profile_id
      and us.opening_id = s.opening_id
      and us.role = 'helper'
      and us.started_at = h.joined_at
  );

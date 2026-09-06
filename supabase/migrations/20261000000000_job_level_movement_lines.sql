-- A job's closing line has no unit on it, and the ledger refused to write it.
--
-- THE INCIDENT (2026-09-06, the owner's phone, DON117): "Unit Movement
-- Finalized" failed with `new row for relation "movements" violates check
-- constraint "movements_one_subject_ck"`, and that raw sentence reached the
-- installer. 20260999000000 gave a job two new lines in the one movement log —
-- 'finalized' when the material story closes, 'reopened' when it is opened
-- again — written against the JOB alone: project_id, event, actor, reason.
-- 20260825000000_one_movement_log.sql had made the rule that every line names
-- exactly one subject (a unit, a package, a container or a supply), and
-- nothing in a green pipeline evaluates a check constraint before production
-- does: the unit tests never touch Postgres, the migration replay checks
-- shape, and the e2e answers from fixtures. So the first person to press the
-- button was the owner, on a real job.
--
-- THE RULE, KEPT AND WIDENED. One subject per line stays the law for every
-- movement of material — it is what makes the ledger readable and undoable.
-- The two job-level events are a different kind of line: they are about the
-- job's story, not about a piece, and they carry NO subject on purpose. So the
-- constraint now says: exactly one subject, OR one of those two events with
-- the job named and no subject at all. Any other event with no subject, or a
-- job-level event that also names a piece, is still refused.
--
-- Lands after 20260999000000, which it repairs. Idempotent: drops the old
-- constraint if present and adds the new one under the same name, so a
-- second run is a no-op.

alter table movements drop constraint if exists movements_one_subject_ck;

alter table movements add constraint movements_one_subject_ck check (
  (
    (window_id is not null)::int
    + (package_id is not null)::int
    + (container_id is not null)::int
    + (supply_id is not null)::int
    = 1
  )
  or (
    event in ('finalized', 'reopened')
    and project_id is not null
    and window_id is null
    and package_id is null
    and container_id is null
    and supply_id is null
  )
);

comment on constraint movements_one_subject_ck on movements is
  'Every movement of material names exactly one subject (unit, package, container or supply). The two job-level lines — finalized, reopened — name the job and nothing else. Widened 2026-09-06 after the first finalize on production was refused.';

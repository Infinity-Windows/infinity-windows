-- Capture anywhere (owner's ask, 2026-09-05): "it should also be able to
-- capture a photo and assign it to a job."
--
-- ONE CHANGE, AND IT IS A BUG FIX, NOT A FEATURE.
--
-- `attachments_target` says an attachment must hang off SOMETHING. It has
-- listed four things since 20260977000000 — a window, an install event, a
-- package, an opening — and has never listed the job itself:
--
--     check (window_id is not null
--         or install_event_id is not null
--         or package_id is not null
--         or project_opening_id is not null)
--
-- A job-feed photo hangs off the job and nothing else. `JobPhotoCapture` has
-- written exactly that row since the feed was built — project_id set, every
-- other target null — which is a 23514 check violation on every single one.
--
-- HOW THAT STAYED INVISIBLE. The photo is queued in the offline outbox first
-- and the person is told it saved, truthfully: it did, to their phone. The
-- upload handler then peels back through its tiers on a MISSING COLUMN, and a
-- check violation is not a missing column, so the entry burned its eight
-- retries and dead-lettered into Stuck writes — a screen an installer had no
-- menu row for until this same change gave them one. The photo was on the
-- phone and nowhere else, and nobody was told.
--
-- Verified against production on 2026-09-05, read-only: `project_opening_id`
-- exists on `attachments`, so 20260977000000 (the migration that last rewrote
-- this constraint) is applied and the live constraint is the four-target form
-- above. Rows with project_id set and every other target null: zero — which is
-- what a constraint that rejects them looks like from the outside. The two
-- attachments rows that exist both carry an install_event_id.
--
-- Widening rather than hanging the photo off a fake target: a photo of a job
-- is about the job. Inventing a window to point it at would be a lie in the
-- data to satisfy a check, and the next person to read the row would believe
-- it. `project_id` is already a real, indexed, foreign-keyed column here
-- (20260721002000) — it just was never allowed to stand on its own.
--
-- Note for whoever touches this next, carried forward from 20260936000000:
-- `attachments.service_case_id` (20260718070000) still is not in this list. It
-- costs nothing today because no app code writes that column alone, but a row
-- that set only service_case_id would fail the same way this one did.

alter table attachments drop constraint if exists attachments_target;
alter table attachments add constraint attachments_target
  check (
    window_id is not null
    or install_event_id is not null
    or package_id is not null
    or project_opening_id is not null
    or project_id is not null
  );

comment on constraint attachments_target on attachments is
  'An attachment hangs off something: a window, an install event, a package, an '
  'opening, or the job itself. The job was added 2026-09-05 — the job photo feed '
  'had been writing project-only rows since it was built and every one of them '
  'was failing this check and dead-lettering in the offline queue.';

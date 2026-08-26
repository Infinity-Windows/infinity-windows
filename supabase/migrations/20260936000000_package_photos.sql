-- A package can carry a photo (owner pick 28): snapped at check-in or any
-- time from PackageSheet — condition on arrival, where it sits, anything
-- worth a picture over a package's life.
--
-- ------------------------------------------------------- where the row goes
--
-- Reuses `attachments`, the table every other photo in the app already hangs
-- off (window installs, the job feed, damage reports), rather than a new
-- table. A package can pick up several photos over its life, which is
-- exactly the one-row-per-photo shape attachments already has — unlike the
-- single `issues.photo_path` COLUMN ticket 11 added for a damage report
-- (20260922000000): that one photo belongs to a row (the issue) that already
-- exists at the moment it's taken, so a column was the smaller move. A
-- package's photos have no such single owning row to sit on, so attachments
-- is the shape that fits, the same way it already does for window_id and
-- install_event_id.
--
-- attachments_target (20260715120000) only accepts window_id or
-- install_event_id — a package-only row (neither) would fail that check the
-- moment it was inserted, so this widens it to also accept package_id. Note
-- for whoever touches this next: attachments.service_case_id
-- (20260718070000) has the exact same gap and was never added to this check
-- — it happens to cost nothing today because no app code writes that column,
-- but it is not actually reachable if anything ever does. Not fixed here;
-- flagging it because this migration is proof the gap is real.
alter table attachments add column if not exists package_id uuid
  references packages(id) on delete cascade;
create index if not exists attachments_package_idx on attachments (package_id);

alter table attachments drop constraint if exists attachments_target;
alter table attachments add constraint attachments_target
  check (
    window_id is not null
    or install_event_id is not null
    or package_id is not null
  );

-- ---------------------------------------------------------------- the bucket
--
-- No new bucket: install-media already holds every attachments-table photo
-- (window installs, the job feed) behind one "any authenticated user" policy
-- (20260715120000) with no per-project or per-kind narrowing, which already
-- matches how packages themselves are treated everywhere else (trusted crew,
-- same as install-media's own policy comment). A package photo is just
-- another attachments row with kind='photo', so it rides the same bucket and
-- the same policy — nothing to add here.

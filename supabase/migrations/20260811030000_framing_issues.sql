-- Framing issues: what the rough-opening checklist files.
--
-- The RO check (owner's rule, 2026-08-11) is measured against the WINDOW,
-- not a flat number: the opening must be at least 1/8" looser than the unit
-- overall (tighter and it won't shim in) and at most 1/2" looser (sloppier
-- is a framing problem). Out of square is its own check (the X across the
-- diagonals). Any failure — a Bad tap or measurements that prove it — files
-- one of these, labeled with the window, so the framer's fix-list writes
-- itself.

alter table issues drop constraint if exists issues_kind_check;
alter table issues add constraint issues_kind_check
  check (kind in (
    'failed_install','flag','damage','blocker','complication','missing',
    'spec_gap','framing'
  ));

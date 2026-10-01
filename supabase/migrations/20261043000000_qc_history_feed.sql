-- Quality's recent-review feed reads across jobs, newest decision first.
-- The original opening-first index serves a single unit's timeline; this one
-- keeps the cross-job history bounded as the audit table grows.
create index if not exists qc_decision_events_recent_idx
  on public.qc_decision_events (decided_at desc, id desc);

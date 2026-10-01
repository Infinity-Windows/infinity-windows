-- AI failures join the owner's existing App Issues inbox. Original reports,
-- kind/status values and the existing author/owner RLS boundaries are kept.
alter table public.app_feedback add column if not exists category text not null default 'app'
  check (category in ('app', 'ai'));
alter table public.app_feedback add column if not exists resolution_note text
  check (resolution_note is null or length(trim(resolution_note)) between 1 and 2000);
create index if not exists app_feedback_category_status_idx
  on public.app_feedback (category, status, created_at desc);

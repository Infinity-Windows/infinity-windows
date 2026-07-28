-- Per-page progress for a specs planset extraction.
--
-- Spec extraction runs in the BROWSER: the client renders each page and calls
-- `extract-specs` for it. Before this table the only record of a run was the
-- planset's `status`, so navigating away mid-run left the row stuck on
-- 'extracting' forever with no way to tell how far it got — and a retry had to
-- redo every page. One row per (planset, page) makes the progress durable, so
-- the bar survives a refresh, another device can watch it, and an interrupted
-- run resumes from the first page that never completed.
--
-- Shape mirrors the `SpecPageStatus` the edge function already returns
-- (ok / attempts / markCount / error), so this is that payload, persisted.

create table if not exists project_planset_pages (
  planset_id uuid not null references project_plansets(id) on delete cascade,
  page_number int not null check (page_number >= 1),
  -- False means the vision call for this page never completed. Pages that
  -- finished with zero marks are ok=true, mark_count=0 (a genuinely empty
  -- sheet), which is the distinction the whole per-page status exists to make.
  ok boolean not null default false,
  attempts int not null default 0 check (attempts >= 0),
  mark_count int not null default 0 check (mark_count >= 0),
  error text,
  updated_at timestamptz not null default now(),
  primary key (planset_id, page_number)
);

create index if not exists project_planset_pages_updated_idx
  on project_planset_pages(planset_id, updated_at desc);

comment on table project_planset_pages is
  'Durable per-page outcome of a client-driven specs extraction; powers the progress bar and resume.';

alter table project_planset_pages enable row level security;

do $$
begin
  create policy "authenticated full access" on project_planset_pages
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null;
end $$;

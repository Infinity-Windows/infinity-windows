-- Two fences for the job-plan and unit-detail tables.
--
-- 1. The sandbox guard. The four tables' own migrations now arm it, but three
--    of those files reached the live database before that line existed, so it
--    is run once more here. It is idempotent.
select public.attach_sandbox_guards();

-- 2. The partner wall. A person may read the receipt of their own unit edit;
--    a partner (builder) login must not read this table at all, like every
--    other internal table (20260950000000).
drop policy if exists unit_detail_edit_receipt on public.unit_detail_edit_history;
create policy unit_detail_edit_receipt on public.unit_detail_edit_history
  for select to authenticated using (not public.is_partner_user() and actor_id = auth.uid());

-- Ensure multiple manual outlines are allowed per planset page.
-- Safe to re-run after 20260718010000_manual_plan_outlines.sql.

alter table project_plan_outlines
  drop constraint if exists project_plan_outlines_planset_id_page_number_key;

create index if not exists project_plan_outlines_page_idx
  on project_plan_outlines(planset_id, page_number, created_at);

-- Preserve real pre-column snapshots across the migration, including old drafts.
create table fixture_old_snapshots as select id,workflow_snapshot(id) as snapshot from workflow_plans;

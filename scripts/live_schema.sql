-- One catalog snapshot of the live database, flattened to `kind|key` rows so it
-- can be diffed against what supabase/migrations/ declares.
-- Run with: scripts/pgq.sh scripts/live_schema.sql > /tmp/live_schema.json
select 'table|'||c.relname||'|'||(case when c.relrowsecurity then 'rls' else 'norls' end) as k
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relkind in ('r','p','v','m','f')
union all
select 'column|'||table_name||'.'||column_name||'|'||data_type||'|'||is_nullable||'|'||coalesce(column_default,'-')
  from information_schema.columns where table_schema='public'
union all
select 'index|'||tablename||'|'||indexname from pg_indexes where schemaname='public'
union all
select 'constraint|'||conrelid::regclass::text||'|'||conname||'|'||contype::text
  from pg_constraint where connamespace='public'::regnamespace
union all
-- Policies from EVERY schema: storage.objects policies are created by several
-- migrations and would look missing if only `public` were scanned.
select 'policy|'||schemaname||'.'||tablename||'|'||policyname from pg_policies
union all
-- Functions from every schema, for the same reason.
select 'anyfunction|'||n.nspname||'.'||p.proname
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
union all
select 'trigger|'||event_object_table||'|'||trigger_name
  from information_schema.triggers where trigger_schema='public'
union all
select 'publication|'||pubname||'|'||schemaname||'.'||tablename from pg_publication_tables
union all
select 'enum|'||t.typname||'|'||e.enumlabel
  from pg_type t join pg_enum e on e.enumtypid=t.oid
  join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'
union all
select 'view|'||table_schema||'.'||table_name from information_schema.views
 where table_schema not in ('pg_catalog','information_schema')
union all
select 'sequence|'||sequence_name from information_schema.sequences where sequence_schema='public'
union all
select 'extension|'||extname from pg_extension
union all
select 'bucket|'||id from storage.buckets
union all
-- Check-constraint definitions, so a constraint that was dropped and re-added
-- with a WIDER value list is not mistaken for the current one.
select 'checkdef|'||conname||'|'||pg_get_constraintdef(oid)
  from pg_constraint where connamespace='public'::regnamespace and contype='c'
union all
select 'migration|'||version from supabase_migrations.schema_migrations
order by 1

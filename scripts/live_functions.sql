-- Live body of every function in `public`, for comparison against the last
-- migration that defines it. `create or replace function` is invisible to an
-- existence check, so body text is the only way to catch a stale function.
-- Run with: scripts/pgq.sh scripts/live_functions.sql > /tmp/live_functions.json
select p.proname||'|#|'||pg_get_function_identity_arguments(p.oid)||'|#|'||p.prosrc as k
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prokind='f'
order by 1

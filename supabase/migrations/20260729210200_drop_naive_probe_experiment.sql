-- Remove the leftover concurrency experiment: `_naive_probe` and the two
-- functions that were written to race against each other on it.
--
-- `public._naive_probe` is the only table in the schema with row-level security
-- switched off. It was created to compare a naive read-then-write counter
-- against an atomic upsert and was never removed. It holds a single row of
-- experiment residue:
--
--   {"user_id": "958d3bfc-946e-46b3-a84c-a84d5f586a2e", "calls": 10}
--
-- That is the owner's own id with a counter of 10 — the tally left behind by
-- the experiment, not anybody's data. Nothing reads it: no foreign key points
-- at it (0 referencing constraints) and no file in app/src, supabase/functions
-- or supabase/migrations mentions it.
--
-- The two functions go with it. `_atomic_probe(uuid, int)` and
-- `_naive_reserve(uuid, int)` are the two halves of the experiment; both write
-- only to `_naive_probe`, and both call `pg_sleep(0.4)` to widen the race
-- window. Dropping the table alone would leave two SECURITY DEFINER functions
-- that any signed-in caller can invoke, that sleep for four tenths of a second
-- per call, and that now fail on a missing table — worse than either keeping or
-- removing the whole experiment. They are dropped as one unit for that reason.
--
-- Rollback (recreates the table, the row and both functions) is at the bottom
-- of docs/security-followups-2026-07-29.md.

begin;

-- Refuse to run if this database's copy is not the residue we inspected. If
-- something started using the table since, this migration must be re-thought
-- rather than silently take data with it.
do $$
declare
  n int;
  unexpected int;
begin
  if to_regclass('public._naive_probe') is null then
    raise notice '_naive_probe is already gone; nothing to drop';
    return;
  end if;

  select count(*) into n from public._naive_probe;
  select count(*) into unexpected
  from public._naive_probe
  where user_id <> '958d3bfc-946e-46b3-a84c-a84d5f586a2e'::uuid or calls <> 10;

  if n > 1 or unexpected > 0 then
    raise exception
      '_naive_probe holds % row(s), % of them unrecognised - refusing to drop a table that is in use', n, unexpected;
  end if;
end $$;

drop function if exists public._atomic_probe(uuid, integer);
drop function if exists public._naive_reserve(uuid, integer);
drop table if exists public._naive_probe;

-- Assert the effect, including the thing this was really about: no table in
-- `public` may be left with row-level security switched off.
do $$
declare
  rls_off text;
begin
  if to_regclass('public._naive_probe') is not null then
    raise exception '_naive_probe is still there';
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into rls_off
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if rls_off is not null then
    raise exception 'table(s) in public still have row-level security off: %', rls_off;
  end if;

  raise notice 'experiment removed; every table in public now has row-level security on';
end $$;

commit;

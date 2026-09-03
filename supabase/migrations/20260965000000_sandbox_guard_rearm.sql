-- The test-login cage re-arms itself, and the deploy proves it is shut.
--
-- WHAT WENT WRONG (owner report, 2026-09-02)
--
-- The QA foreman test login wrote to BLACK22 — a live job — twice: once
-- through the finish_unit RPC and once through a plain PATCH on
-- project_openings. 20260730220000_test_accounts_sandbox_only.sql exists to
-- make exactly that impossible, and its own header calls itself "a CONTROL,
-- not a convention". The control had quietly stopped covering most of the
-- database.
--
-- WHY THE GUARD WENT MISSING. Three causes, and none of them is "somebody
-- dropped the trigger" — nothing in supabase/migrations/ ever drops
-- guard_test_account_sandbox_only, and 20260730220000 has no down block or
-- reset path (the second loop near its end is test_account_write_scope(), a
-- read-only report).
--
--   1. THE ATTACH RAN ONCE. Section 5 of 20260730220000 is a `do $$ … $$`
--      block that walks the catalogue and attaches the trigger to every
--      project-scoped table. `supabase db push` applies a migration file
--      exactly once, so that walk saw the catalogue as it stood on
--      2026-07-30 and has never run again. FOURTEEN project-scoped tables
--      have been created since, and not one of them has ever carried the
--      guard: unit_sessions and unit_redos (20260820000000 — what finish_unit
--      writes, which is half of the owner's incident), opening_phases
--      (20260811000000), opening_notes (20260923000000), summons
--      (20260818000000), packages and package_events (20260814000000),
--      studio_projects (20260815000000), flash_run_assignments
--      (20260817000000), project_marks (20260822000000), takeoffs
--      (20260917000000), daily_logs (20260949000000), partner_job_grants
--      (20260950000000) and receipts (20260957000000).
--
--   2. A TABLE THAT IS DROPPED TAKES ITS TRIGGERS WITH IT. Two tables that
--      WERE guarded on day one were later dropped and recreated under the
--      same name — project_marks (20260822000000 drops the undeclared orphan
--      and declares a real one) and package_events (20260825000000). Postgres
--      drops the triggers along with the table, so those two lost a guard
--      they had once had, silently, on a migration whose subject was
--      something else entirely.
--
--   3. NOTHING EVER MEASURED IT. The coverage report that would have caught
--      this — test_account_write_scope(), section 9 of 20260730220000 — has
--      exactly one caller, scripts/provision-test-foreman.py, which runs on
--      demand and not on a deploy. And that script's own pre-flight check
--      asks whether the trigger count is greater than zero, which stays true
--      with one table guarded out of forty-three. So the fence could rot from
--      complete to two-thirds while every merge went green.
--
-- WHAT THIS MIGRATION DOES ABOUT IT
--
-- The one-shot `do` block becomes a function anyone deploying can call again:
-- attach_sandbox_guards(). It is idempotent, it fixes a guard attached to the
-- wrong column or switched off as well as a missing one, and 20260965000000
-- (this file) calls it, so every table listed above is covered the moment this
-- lands.
--
-- Re-arming is not a fix on its own — the one-shot block was "fixed" on the
-- day it ran too. So this also adds sandbox_guard_census(): the project-scoped
-- tables that LACK the guard right now, read off pg_trigger. Empty is the only
-- acceptable answer. scripts/verify-sandbox-guard.sh reads it after every
-- `supabase db push` and FAILS the deploy when it is not empty, the same way
-- scripts/verify-schema.sh fails a deploy whose migrations did not apply.
-- scripts/test_sandbox_guard.py closes the other end: a future migration that
-- makes a table project-scoped — creating it, recreating it, or adding the
-- column that ties it to a job — and does not call attach_sandbox_guards() in
-- that same file fails CI before it can ever reach the database. In that same
-- file, not merely before the next arming call: files are applied in whatever
-- order they are still pending, so a branch numbered below this one and merged
-- after it lands on a database this sweep has already run over.
--
-- SEPARATE FINDING, DELIBERATELY NOT CHANGED HERE. The guard refuses writes
-- outside public.sandbox_projects, and 20260933000000_testing_projects.sql
-- (2026-08-25) both put every is_test job into that table and seeded BLACK22
-- into it by name. So on the live database a test login writing BLACK22 may
-- well be a guard working exactly as written against a sandbox that grew to
-- include a job people still treat as real. That is a decision about which
-- jobs are practice data, not a bug in this fence, and quietly reversing it
-- would break the testing-projects feature. It is reported instead: the deploy
-- check prints every job a test login may write, by job code, on every merge —
-- and says in its FIRST line how many of them are real jobs rather than the
-- automation sandbox, because "fence: HOLDING" over a list nobody reads is how
-- this went unremarked from 2026-08-25 to 2026-09-02. The open question is
-- .scratch/test-login-fence/issues/01-a-real-job-is-inside-the-sandbox.md and
-- it is the owner's to answer. Until he does, this migration leaves a test
-- login able to write BLACK22: every table is guarded, and that job is inside
-- the fence.
--
-- WHAT CHANGES FOR A REAL PERSON: nothing. Every guard returns on its first
-- statement unless auth.uid() is a profiles.is_test account, of which there
-- are two, and neither belongs to a crew member.
--
-- WHAT CHANGES FOR THE QA LOGINS: they lose write access to the fourteen
-- tables above outside the sandbox — which is the point. One consequence is
-- worth naming: packages.project_id, receipts.project_id and
-- studio_projects.project_id are nullable, and a row whose project cannot be
-- determined is refused rather than waved through (the rule
-- is_sandbox_project() has followed since 20260730220000). So a QA login can
-- no longer write an unassigned Boneyard package. That is the safe direction
-- and it is intended.
--
-- Idempotent and safe to re-run.


-- ---------------------------------------------------------------------------
-- 1. One definition of "project-scoped table"
-- ---------------------------------------------------------------------------
-- The 2026-07-30 migration wrote this rule out twice — once in the attach
-- loop, once in test_account_write_scope() — and the two were free to drift.
-- They stay in step here by being one function that both the attacher and the
-- census read. Precedence is unchanged: every table has an `id`, so `id` is
-- the answer only for `projects` itself; otherwise a direct `project_id` wins,
-- then a link to an opening.
--
-- Ordinary tables only (relkind 'r'): a BEFORE … FOR EACH ROW trigger cannot
-- sit on a partitioned parent, and a view has nothing to guard.
--
-- Read from pg_catalog rather than information_schema. information_schema
-- shows a caller only the columns it holds a privilege on, which is a strange
-- thing for a security census to depend on; pg_attribute shows what is there.

create or replace function public.sandbox_scoped_tables()
returns table (table_name text, link_column text, link_kind text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.relname::text, link.col, link.kind
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral (
    select v.col, v.kind
    from (values
            ('id',                 'project', 0),
            ('project_id',         'project', 1),
            ('project_opening_id', 'opening', 2),
            ('opening_id',         'opening', 3)
         ) as v(col, kind, precedence)
    -- `id` is the link for `projects` and for nothing else.
    where (v.col = 'id') = (c.relname = 'projects')
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid
          and a.attname = v.col
          and a.attnum > 0
          and not a.attisdropped
      )
    order by v.precedence
    limit 1
  ) as link
  where n.nspname = 'public'
    and c.relkind = 'r'
    -- The list of sandbox jobs itself. No client role can read or write it at
    -- all (20260730220000 revokes every grant and enables RLS with no policy),
    -- so guarding it would be guarding a door that is already welded shut.
    and c.relname <> 'sandbox_projects'
  order by 1;
$$;

comment on function public.sandbox_scoped_tables() is
  'Every public table a row can be traced from to a project, and the column that does the tracing. The single definition of "project-scoped" shared by attach_sandbox_guards() and sandbox_guard_census(), so the fence and the report on the fence can never disagree.';

revoke all on function public.sandbox_scoped_tables() from public, anon, authenticated;
grant execute on function public.sandbox_scoped_tables() to service_role;


-- ---------------------------------------------------------------------------
-- 2. Attach the guard everywhere, again, and as often as anyone likes
-- ---------------------------------------------------------------------------
-- The body of 20260730220000's section 5, lifted out of its `do` block so it
-- can be called by the migration that adds a table instead of only by the one
-- that invented the idea.
--
-- A table already carrying the right trigger is left alone rather than dropped
-- and recreated. `drop trigger` takes an ACCESS EXCLUSIVE lock, and this
-- function is meant to be called on a live database on every deploy that adds
-- a table: forty-odd exclusive locks to change nothing is a real cost paid for
-- tidiness. "Right" means the guard function, the timing and events, the two
-- arguments, AND that the trigger is switched on — a trigger reading a column
-- the table no longer links through is re-attached, not passed over.
--
-- SWITCHED ON is checked because a trigger can be present and inert.
-- `alter table … disable trigger` during a bulk data repair, or a pg_restore
-- run with --disable-triggers, leaves tgenabled = 'D': the row is still in
-- pg_trigger with the right name, the right function, the right arguments and
-- the right tgtype, and it fires on nothing. A census that did not look would
-- return no rows and the deploy would print "fence: HOLDING" over a database
-- where a test login can write every job — the same silent rot as the one-shot
-- attach, in a new costume. 'O' fires on ordinary writes and 'A' fires always;
-- 'D' is off and 'R' fires only on a replica, which for our purposes is off.
--
-- tgtype is compared as a number on purpose. 1|2|4|8|16 = 31 is
-- ROW|BEFORE|INSERT|DELETE|UPDATE, the shape 20260730220000 created, and the
-- bits are stable across Postgres versions in a way that the exact wording of
-- pg_get_triggerdef() is not.
--
-- The two arguments are looked for as QUOTED literals, one at a time, rather
-- than as one `('col', 'kind')` string. pg_get_triggerdef() always renders
-- arguments as SQL literals but the spacing between them is its own business,
-- and a check that goes red because a Postgres upgrade dropped a space would
-- fail a deploy over nothing. The quotes are what make it exact: `'opening_id'`
-- does not occur inside `'project_opening_id'`, because the character before
-- `opening_id` there is an underscore and not a quote.

create or replace function public.attach_sandbox_guards()
returns table (table_name text, link_column text, link_kind text, action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r      record;
  v_def  text;
  v_type smallint;
  v_on   boolean;
begin
  for r in select * from public.sandbox_scoped_tables()
  loop
    select pg_get_triggerdef(tg.oid), tg.tgtype, tg.tgenabled in ('O', 'A')
      into v_def, v_type, v_on
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_trigger tg on tg.tgrelid = c.oid
    where n.nspname = 'public'
      and c.relname::text = r.table_name
      and tg.tgname = 'guard_test_account_sandbox_only'
      and tg.tgfoid = 'public.guard_test_account_sandbox_only()'::regprocedure
      and not tg.tgisinternal;

    if v_def is not null
       and coalesce(v_on, false)
       and v_type = 31
       and position(quote_literal(r.link_column) in v_def) > 0
       and position(quote_literal(r.link_kind) in v_def) > 0
    then
      table_name  := r.table_name;
      link_column := r.link_column;
      link_kind   := r.link_kind;
      action      := 'already armed';
      return next;
      continue;
    end if;

    execute format(
      'drop trigger if exists guard_test_account_sandbox_only on public.%I',
      r.table_name);
    execute format(
      'create trigger guard_test_account_sandbox_only '
      'before insert or update or delete on public.%I '
      'for each row execute function public.guard_test_account_sandbox_only(%L, %L)',
      r.table_name, r.link_column, r.link_kind);

    table_name  := r.table_name;
    link_column := r.link_column;
    link_kind   := r.link_kind;
    action      := case when v_def is null then 'attached' else 're-attached' end;
    return next;
  end loop;
end;
$$;

comment on function public.attach_sandbox_guards() is
  'Puts guard_test_account_sandbox_only on every project-scoped table, and repairs one attached to the wrong column or switched off. Idempotent — a table already correctly guarded is not touched. Any migration that makes a table project-scoped — creating it, recreating it, or adding the column that ties it to a job — must end with `select public.attach_sandbox_guards();`; scripts/test_sandbox_guard.py fails CI if one forgets.';

revoke all on function public.attach_sandbox_guards() from public, anon, authenticated;
grant execute on function public.attach_sandbox_guards() to service_role;


-- ---------------------------------------------------------------------------
-- 3. What the fence still does not cover
-- ---------------------------------------------------------------------------
-- The deploy proof. Every row this returns is a table a test login can write
-- on any job in the database, so the only acceptable answer is no rows.
--
-- Measured off pg_trigger, not off a list of what was intended: the whole
-- reason this file exists is that the intention was recorded in a migration
-- and the database did not match it.

create or replace function public.sandbox_guard_census()
returns table (table_name text, link_column text, link_kind text, reason text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.table_name,
    s.link_column,
    s.link_kind,
    case
      when tg.oid is null then 'no sandbox guard on this table'
      when tg.tgenabled not in ('O', 'A') then 'the guard is switched off and fires on nothing'
      when tg.tgtype <> 31 then 'the guard does not fire on every write'
      else 'the guard reads a column this table no longer links through'
    end
  from public.sandbox_scoped_tables() s
  join pg_class c on c.relname::text = s.table_name and c.relkind = 'r'
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  left join pg_trigger tg
    on  tg.tgrelid = c.oid
    and tg.tgname = 'guard_test_account_sandbox_only'
    and tg.tgfoid = 'public.guard_test_account_sandbox_only()'::regprocedure
    and not tg.tgisinternal
  where tg.oid is null
     -- A DISABLEd trigger passes every other test in this query: right name,
     -- right function, right arguments, right tgtype, and it fires on nothing.
     -- Nothing in this repo disables it, but `alter table … disable trigger`
     -- during a data repair and `pg_restore --disable-triggers` both leave it
     -- that way, and a fence that is down has to read as down.
     or tg.tgenabled not in ('O', 'A')
     or tg.tgtype <> 31
     or position(quote_literal(s.link_column) in pg_get_triggerdef(tg.oid)) = 0
     or position(quote_literal(s.link_kind) in pg_get_triggerdef(tg.oid)) = 0
  order by s.table_name;
$$;

comment on function public.sandbox_guard_census() is
  'The project-scoped tables a test login could still write on ANY job, because the sandbox guard is missing, switched off, or mis-attached. Empty is the only healthy answer; scripts/verify-sandbox-guard.sh fails the deploy on any row.';

revoke all on function public.sandbox_guard_census() from public, anon, authenticated;
grant execute on function public.sandbox_guard_census() to service_role;


-- ---------------------------------------------------------------------------
-- 4. Arm it now, and refuse to finish if it did not take
-- ---------------------------------------------------------------------------
-- A migration that exits 0 proves the file ran, not that the fence is up —
-- the same distinction scripts/verify-schema.sh was written for. So this asks
-- the census before it lets the transaction commit.

do $$
declare
  v_total int;
  v_armed int;
  v_left  text;
begin
  select count(*), count(*) filter (where action <> 'already armed')
    into v_total, v_armed
  from public.attach_sandbox_guards();

  raise notice 'sandbox guard: % project-scoped table(s), % newly armed', v_total, v_armed;

  select string_agg(table_name, ', ' order by table_name)
    into v_left
  from public.sandbox_guard_census();

  if v_left is not null then
    raise exception
      'the sandbox guard is still missing from: %', v_left
      using hint = 'A test login can write those tables on any job. Do not deploy over this.';
  end if;
end;
$$;

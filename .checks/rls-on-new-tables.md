---
name: rls-on-new-tables
description: Whether a new or altered table arrives with row security, the partner guard, revoked default grants, and the test-login fence.
model: claude-sonnet-5
paths-glob: supabase/migrations/*.sql
max-turns: 14
---

You are reading the migrations in this pull request. The question is whether
every table it creates or re-shapes arrives with its door shut.

## Why this matters here

Every crew member, every builder on a partner portal, and every QA login talks
to the same Postgres database with the same anon key. Nothing but row-level
security stands between them. Four things have to be true for a table anybody
with a login can reach, and each one has an incident behind it:

1. **Row security is on.** `alter table <t> enable row level security`. Without
   it every policy in the file is decoration.
2. **The default grants are revoked.** Supabase hands `anon` and `authenticated`
   a grant on every new table in `public`. `revoke all on <t> from anon,
   authenticated` first, then grant back exactly what the app needs. Row
   security is the second lock, not the first.
3. **The partner guard is in the policy.** `not public.is_partner_user()`, in
   every policy a login can reach. THE WALL (`20260950000000`) exists because a
   builder's portal login could otherwise read another builder's jobs.
4. **The test-login fence is armed** when the table is project-scoped — that is,
   when a row can be traced to a job, usually through a `project_id` column.
   `select public.attach_sandbox_guards();` in the same file. The fence was
   attached by a `do` block that ran once, on 2026-07-30; fourteen tables added
   since never carried it, and on 2026-09-02 a QA login wrote to a live job.

`scripts/advisory-rules.sh` already checks 1, 2 and 3 by pattern, and
`scripts/test_sandbox_guard.py` checks 4 by replaying the migrations. You are
here for what a pattern cannot see.

## What to look for

- A policy that is present and technically carries the guard but is **wider than
  the migration's own comment says it is** — `using (true)` under a heading that
  promises "only the crew who worked this job".
- A policy split per command (`for select` / `for insert` / …) where one command
  quietly got a wider condition than the others, when the comment says nothing
  changed about writes.
- A table made project-scoped by an `alter table ... add column project_id`
  rather than a `create table`. That is the exact shape that slipped past for
  five weeks. Say whether `attach_sandbox_guards()` is called in the same file.
- A `security definer` function reached from a policy that takes an id as an
  argument: does it repeat the partner guard inside itself? Handing it another
  job's id is otherwise a way around the wall.
- A `RETURNING` clause behind a narrowed SELECT policy: a write whose row cannot
  be read back looks to the app's offline queue like a failed write, and it
  retries a row that is already saved.
- Storage buckets. A policy on a table says nothing about the bytes in
  `storage.objects`. If the migration narrows a table's read but the bucket
  behind it stays open, say so plainly rather than calling the migration done.

Read the migration files in the checkout when you need the lines around a hunk;
read the migrations they name when they name one.

## What is NOT a finding

- A missing `attach_sandbox_guards()` on a table with no route to a job.
- A policy narrower than you would have written. Narrow is the safe direction.
- Style, ordering, naming, or the absence of an index.
- Anything the deterministic rules already print — do not repeat them.

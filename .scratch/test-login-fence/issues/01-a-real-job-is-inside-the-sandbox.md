# 01 — A real job is inside the sandbox

Status: ready-for-human

Needs the owner. Nothing here can be answered by reading the code.

## The question

Should the QA test logins be able to write **Black Desert (BLACK22)**?

Right now they can, and that is not a bug in the fence. On 2026-08-25,
`supabase/migrations/20260933000000_testing_projects.sql` did two things to that
job, both on purpose and both owner-confirmed at the time:

- section 4 set `projects.is_test = true` on BLACK22, which **hides it from
  everyone below supervisor** and keeps its packages out of every warehouse
  inventory figure;
- the same section inserted BLACK22 into `public.sandbox_projects`, which is the
  list of jobs a `profiles.is_test` login is permitted to write.

So on 2026-09-02, when the QA foreman login finished a unit on BLACK22 and
PATCHed one of its openings, `guard_test_account_sandbox_only` allowed it
because it was told to. The owner reported that as an incident.

Both readings are defensible and they cannot both stand:

1. **BLACK22 is practice data.** It was declared so a week earlier, it is
   already invisible to the crew, and the QA writes were the feature working.
   Then nothing changes, and the fence's job is to make sure the *rest* of the
   database stays out of reach.
2. **BLACK22 is a real job.** It has real openings, real installs and a mark the
   owner personally repaired (`20260730130000`). Then it comes out of
   `sandbox_projects`, and the QA logins get a job that was never anybody's
   house.

## What has already been done

`20260967000000_sandbox_guard_rearm.sql` put the guard back on the fourteen
project-scoped tables that never had it, and every backend deploy now prints
which jobs a test login may write — naming any job that is not the automation
sandbox (`ZZTEST`) as a real job, in the summary headline. The fence itself is
measured on every deploy and fails it when a table is missing the guard.

That closes the half that is engineering. It deliberately does **not** touch
this one: quietly removing a job the owner declared practice data would undo a
decision without asking, and would break the testing-projects feature's own
rule that a testing project is exactly what a QA account should be able to
write.

## To act on answer 2

Two lines, and they are separable:

- **Out of the sandbox, still hidden:** delete BLACK22's row from
  `sandbox_projects`. QA can no longer write it; it stays invisible below
  supervisor. Note that `set_project_test(id, true)` would put it straight back,
  so the flag has to come off too or the next toggle re-opens it.
- **Back to being an ordinary job:** also set `projects.is_test = false`, which
  makes Black Desert visible to the crew again and returns its packages to the
  warehouse figures. Check with the warehouse before doing this — those packages
  have been excluded from every count for weeks.

Either way it belongs in a migration with the reasoning in its header, not in a
hand-run statement against production.

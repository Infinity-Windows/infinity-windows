# The test-login fence

The QA logins (`profiles.is_test`) may write only the jobs listed in
`public.sandbox_projects`. A BEFORE trigger on every project-scoped table
enforces it — `guard_test_account_sandbox_only`, from
`supabase/migrations/20260730220000_test_accounts_sandbox_only.sql`.

Two halves have to be true at once, and only one of them is an engineering
question.

**Is the guard on every table?** Engineering. `attach_sandbox_guards()` puts it
back and `sandbox_guard_census()` proves it is there
(`20260965000000_sandbox_guard_rearm.sql`). Every backend deploy reads the
census and fails on any row; `scripts/test_sandbox_guard.py` fails CI when a
migration makes a table project-scoped without arming it.

**Which jobs are inside the fence?** Not engineering. A job is inside because a
supervisor flagged it as practice data, or because a migration put it there by
name. That is a call about the business, and the deploy check reports it rather
than deciding it.

The 2026-09-02 incident sat across both halves, which is why it took five weeks
to notice: fourteen tables had no guard at all, *and* the one job the write
landed on had been moved inside the fence a week earlier.

## Issues

- `issues/01-a-real-job-is-inside-the-sandbox.md` — the second half, still open.

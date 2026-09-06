# 13 — Automation register and a run log

Status: ready-for-agent
Type: task
Size: S

## Horizon does

`docs/automation-register.md`: every scheduled automation — cron expression,
endpoint, handler, what it posts where — in one table, with a commit stamp.
Table `automation_log` (action, status, payload, error, created_at); every
hook writes a row. `docs/audit-protocol.md`: the SQL to prove each automation
is alive after a deploy (pre-flight settings, `cron.job` listing, a smoke
trigger per route, then read the log row).

## Forge today

Four sweeps (`pipeline-sweep`, `still-on-the-job-sweep`,
`summon-warning-sweep`, plus the heartbeat) across 7 `cron.schedule` calls in
migrations and edge functions; nightly `vault-sync` and `verify-warehouse`
in GitHub. There is no single list, and a sweep that silently stops looks the
same as one with nothing to do.

## Build

1. Migration: `automation_runs` (name, started_at, finished_at, status,
   summary jsonb, error). Insert-only from the sweeps (service role); read by
   owner/supervisor. Register in merge tooling; the sandbox fence does not
   apply (not project-scoped) — say so in the migration comment.
2. Each sweep writes a row at start and end (`_shared/` helper, ~20 lines).
3. `docs/automation-register.md`: one table, every pg_cron job, edge sweep,
   and GitHub schedule, with the migration or workflow that owns it and what
   "healthy" looks like.
4. A daily check (extend `verify-warehouse.yml` or ticket 03's probe): any
   automation in the register with no successful run in its expected window →
   Slack.
5. Optional: a small "Automations" card on the owner's Home showing last run
   per sweep.

## Done when

- The register lists everything `SELECT jobname, schedule FROM cron.job`
  returns, and nothing it does not.
- Pausing a sweep for a day (in a scratch project or by test stub) produces
  the Slack line.

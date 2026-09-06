# 08 — Every edge function must ask who is calling (CI check)

Status: ready-for-agent
Type: task
Size: S

## Horizon does

`scripts/check-service-role-authz.mjs` (in the hard merge gate): scans
`src/server/`, and any module that uses the service-role client must either
contain a permission check (`rpc("can_…")`/`rpc("is_…")`, `has_role`,
`assertAutomationAuth`, `requireSupabaseAuth`) or be listed in an ALLOWED map
with the REASON it acts for the system rather than a user. The header tells the
incident: a report-fill function let anyone with a report id write onto another
crew's job while every test stayed green.

## Forge today

All 23 `supabase/functions/*/index.ts` import `_shared/auth.ts`
(`verifyCaller` / `requireCaller` / `callerSupabaseClient`) and all 23 use the
service role. That is discipline, not enforcement: nothing makes the 24th
function do it. Sweeps (`pipeline-sweep`, `still-on-the-job-sweep`,
`summon-warning-sweep`) are system actors and would be the allow-list.

## Build

1. `scripts/check-function-auth.sh` (bash, in the style of the other script
   tests): for each `supabase/functions/*/index.ts` that mentions
   `SERVICE_ROLE`, require an import of `_shared/auth` AND a call to
   `requireCaller`/`verifyCaller`, OR an entry in an allow-list file
   `supabase/functions/_shared/SYSTEM_ACTORS.md` with one line of reason each
   (sweeps, `vault-config`, `send-email` if invoked only by triggers…).
2. A test (`check-function-auth.test.sh`) with fixture functions: one that
   checks, one that is allow-listed, one that does neither → fails naming the
   file.
3. Add both to `ci.yml` so `ci-runs-script-tests.test.mjs` counts them.
4. A line in `CLAUDE.md` "Things that will trip you up".

## Done when

- Removing the auth import from `extract-receipt` makes CI red with the file
  name and the sentence "add a caller check or list it as a system actor with
  a reason".

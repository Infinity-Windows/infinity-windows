# Horizon borrowings

Status: needs-triage

Source: the 2026-09-05 side-by-side audit of Horizon Solar Hub (reference clone
at `~/Downloads/horizon-hub-44`, snapshot of its `main` from 2026-08-11) and
this repo at #540. Scores came out 77 vs 76. The report is the artifact
"Horizon vs Forge Audit"; the ranked list there is this directory, one ticket
per item. Doing all of them moves Forge to roughly 90 on the same rubric. The
last ten points are refactors (install/api.ts, ModelStudio, the vendored
renderers) and are deliberately NOT here.

## Ground rules for every ticket

- Horizon is reference-only. Read its file, understand the idea, write it the
  Forge way (CLAUDE.md house style, `formatApiError`, `schemaErrors`,
  plain-English copy, tests beside logic). Never copy Tailwind/shadcn/TanStack
  Start code across.
- No ticket writes to a real job. Probes against production are SELECT-only
  through `scripts/pgq.sh`.
- Each ticket lands as its own PR. Run `npm test` and `npm run lint` in `app/`
  on Node 22 before every push. Full gate first, then checkpoint after merge.
- `~/Downloads/horizon-hub-44` is never modified. Read it, quote it, run its
  tests if you must, but no edits, no branches, no `npm install` side effects
  committed. "Don't touch Horizon" is the owner's standing rule.
- This repo is public. No employee names, user ids, project ids, or point
  totals in any ticket, comment or commit. Say "the owner", "a foreman", "an
  installer".
- Status strings are the five in `docs/agents/triage-labels.md`.
  `ready-for-agent` = fully specified below. `needs-triage` = the owner decides
  whether he wants the feature at all before anyone builds.

## Order

Infrastructure first, product features after, and 14 after 02.

| # | Ticket | Status | Size |
|---|--------|--------|------|
| 01 | Nightly verified off-site database backup | ready-for-agent | S |
| 02 | Run the e2e suite in CI | ready-for-agent | M |
| 03 | Production invariant probe on every PR | ready-for-agent | S |
| 04 | Migration drift nightly and on the PR | ready-for-agent | S |
| 05 | "Download this job" offline preflight | ready-for-agent | M |
| 06 | Weak-signal state, sync pill, diagnostics screen | ready-for-agent | M |
| 07 | Auto-recover from a stale chunk after a deploy | ready-for-agent | S |
| 08 | Every edge function must ask who is calling (CI check) | ready-for-agent | S |
| 09 | Generated Supabase types | ready-for-agent | M |
| 10 | Lint checks that encode incidents | ready-for-agent | S |
| 11 | Notification center with per-type preferences | needs-triage | M |
| 12 | Photo markup and share links | needs-triage | M |
| 13 | Automation register and run log | ready-for-agent | S |
| 14 | Tutorial videos rendered by the e2e suite | ready-for-agent, blocked by 02 | L |
| 15 | Native shell (Capacitor) | wontfix for now | L |
| 16 | Rollback runbook and the additive-migration rule | ready-for-agent | S |
| 17 | Prettier | ready-for-agent | S |
| 18 | Data-health chips on the jobs list | needs-triage | S |
| 19 | Dialog focus trap and aria-modal | ready-for-agent | S |

Items 16–19 are the "smaller borrowings" bundle from the report, split so each
can be claimed on its own.

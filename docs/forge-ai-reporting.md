# Forge AI reporting: first implementation

Status: implemented and verified in an isolated checkout; not deployed or activated in production. This is the reporting slice of the September 21 AI expansion plan.

## What the crew can do

Ask for an hours report with inclusive dates, all time, selected employees or selected jobs. Reports include completed jobs and unassigned time when no job filter is selected. Each report has actual CSV and PDF download buttons. A request without project details produces one daily row per employee. Detailed exports include entry timestamps, breaks, project, cost code and notes.

Foremen and above can request job summaries covering recorded labor, projected and goal hours, recorded stage progress and the ten latest daily logs. Missing sources are identified rather than treated as zero. The model must look up ambiguous names before selecting IDs.

Existing scheduling draft tools remain available. This release does not add job creation, schedule publishing, Hexcore ingestion, saved payroll inclusion presets, persistent conversation/report history, or unit-level analytics. It does not claim whole-app coverage.

## Data and permissions

- A real authenticated, active internal profile is required; partner and service-role callers cannot use Ask.
- New operational reads use the caller JWT and database row security, never the service-role client. Installer reports force the caller's own profile ID. Team reporting and whole-job summaries require foreman or above.
- The owner's existing AI Spend role threshold, call quotas and company budget still apply. Enabling the UI path does not override those settings.
- Vault retrieval is owner-only until document-level authorization is defined. The pre-existing bounded live context still uses its existing role filters.
- Reports page through all matching records, require exact counts, check duplicates, and fail clearly if loading is incomplete or exceeds 10,000 rows. This detects moving counts but is not a transaction across pages; rerun a report if entries are edited concurrently.
- Clock-in day determines date inclusion in the displayed time zone. Midnight boundaries handle daylight saving time. Unit clocks are not added again to their parent shifts.
- Finished hours, running clocks, unresolved clocks and unassigned time are separate. Finished hours use the same shared arithmetic as app timecards. Suspect timestamps and unapproved entries are marked for review.
- Downloads use the exact report snapshot and include finished, non-voided entries only. They do not approve payroll or calculate overtime. Salary exclusions are never guessed.
- Imported source metadata is limited to time-entry export fields; arbitrary future private columns are stripped before responding.
- Report artifacts live only in the current page state. Download them before leaving. Previously downloaded files cannot be revoked by later role changes.

## Provider configuration

Default Ask continues using Claude. The OpenAI adapter uses the Responses API with `store: false`, bounded tool rounds and caller-owned tool execution. No browser key is accepted or exposed.

To activate OpenAI after review and deployment, configure server-side secrets/settings:

- `OPENAI_API_KEY`: the new project key, through the existing secure deployment process.
- `ASK_AI_PROVIDER=openai`.
- `ASK_OPENAI_MODEL=gpt-5.6-terra` (default). `gpt-6-astra` is also allowlisted with separately reviewed pricing.

A local `.env.local` is sufficient for the opt-in synthetic provider test; it does not configure Supabase production. Do not use a `VITE_` credential. No production credential/settings changes were made by this implementation.

The spend guard reserves a conservative whole-loop estimate, settles returned token usage, and charges completed provider rounds even when a later round fails. The adapter never falls back silently to a second billed provider. Revert `ASK_AI_PROVIDER` to the existing default to return to Claude without removing reporting tools.

## Verification

- Full Vitest suite: 410 files / 5,535 tests passed.
- Four browser tests: 390px phone and 1440px desktop reports, actual CSV/PDF downloads, offline refusal, installer personal-report route. Fixture data only.
- Build and lint passed; existing lint warnings remain.
- Deno type-check of the Ask edge function.
- `node --experimental-strip-types scripts/verify-ask-reporting.mjs`: synthetic caller scope, dates, mixed jobs, completed jobs, source-data whitelist, failure handling.
- Opt-in real OpenAI test: English daily employee export, Spanish report, completed-job lookup/summary, using synthetic records only. New key and model responded successfully.
- Exported PDF and phone/desktop layouts visually inspected.

The browser fixtures and live provider tests do not prove production database permissions or deployment. Before enabling this for the crew, verify a signed-in installer can retrieve only personal time, a foreman can read permitted team time, a partner is denied, and an owner report matches Team timecards for identical dates/filters. Check a completed job, unassigned time, a long paginated report, and both download formats. Verify AI Spend policy and the selected provider in the live environment.

## Example requests

- Show all crew hours from September 1 through September 15, 2026, grouped by employee.
- Export Carol's hours for those dates, day by day, without projects.
- Export all recorded hours for Black Desert, including its completed-job history.
- Summarize Mad Moose: recorded labor, goal hours, stages and latest logs.

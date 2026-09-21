# Forge AI reporting: first implementation

Status: shipped September 21, 2026 through PR620 and the off-site access correction in PR621. Frontend and backend deployments passed. An authenticated foreman report was independently reconciled against all 341 matching live shift records for September 1–15; IDs and post-break hours matched. No time records were changed. This is the reporting slice of the September 21 AI expansion plan.

## What the crew can do

Ask for an hours report with inclusive dates, all time, selected employees or selected jobs. Reports include completed jobs and unassigned time when no job filter is selected. Each report has actual CSV and PDF download buttons. A request without project details produces one daily row per employee. Detailed exports include entry timestamps, breaks, project, cost code and notes.

Foremen and above can request job summaries covering recorded labor, projected and goal hours, recorded stage progress and the ten latest daily logs. Missing sources are identified rather than treated as zero. The model must look up ambiguous names before selecting IDs.

Existing scheduling draft tools remain available. This release does not add job creation, schedule publishing, Hexcore ingestion, saved payroll inclusion presets, persistent conversation/report history, or unit-level analytics. It does not claim whole-app coverage.

## Data and permissions

- Off-site availability does not disable AI: `active` is not used as a login authorization gate.
- A real authenticated internal profile with no retirement or access revocation is required; partner and service-role callers cannot use Ask.
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

Production Ask uses OpenAI after this release; the adapter retains Claude as the configurable default for rollback. The OpenAI adapter uses the Responses API with `store: false`, bounded tool rounds and caller-owned tool execution. No browser key is accepted or exposed.

The release configured these server-side secrets/settings through the existing deployment workflow:

- `OPENAI_API_KEY`: the new project key, through the existing secure deployment process.
- `ASK_AI_PROVIDER=openai`.
- `ASK_OPENAI_MODEL=gpt-5.6-terra` (default). `gpt-6-astra` is also allowlisted with separately reviewed pricing.

A local `.env.local` is sufficient for the opt-in synthetic provider test; it does not configure Supabase production. Do not use a `VITE_` credential. The release securely synced these settings to production; no key value is committed or exposed to the browser.

The spend guard reserves a conservative whole-loop estimate, settles returned token usage, and charges completed provider rounds even when a later round fails. The adapter never falls back silently to a second billed provider. Revert `ASK_AI_PROVIDER` to the existing default to return to Claude without removing reporting tools.

## Verification

- Full Vitest suite: 410 files / 5,535 tests passed.
- Four browser tests: 390px phone and 1440px desktop reports, actual CSV/PDF downloads, offline refusal, installer personal-report route. Fixture data only.
- Build and lint passed; existing lint warnings remain.
- Deno type-check of the Ask edge function.
- `node --experimental-strip-types scripts/verify-ask-reporting.mjs`: synthetic caller scope, dates, mixed jobs, completed jobs, source-data whitelist, failure handling.
- Opt-in real OpenAI test: English daily employee export, Spanish report, completed-job lookup/summary, using synthetic records only. New key and model responded successfully.
- Exported PDF and phone/desktop layouts visually inspected.

Production verification used the designated foreman login and independent read-only shift reconciliation. Installer personal scope and partner refusals passed local permission tests; the designated installer login is banned, so authenticated production installer verification remains outstanding. CSV/PDF browser checks used fixtures. These checks do not finalize payroll or approve unapproved time.

## Example requests

- Show all crew hours from September 1 through September 15, 2026, grouped by employee.
- Export Carol's hours for those dates, day by day, without projects.
- Export all recorded hours for Black Desert, including its completed-job history.
- Summarize Mad Moose: recorded labor, goal hours, stages and latest logs.

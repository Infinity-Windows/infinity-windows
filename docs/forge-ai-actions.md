# Forge AI: reviewed jobs and crew schedules

Status: next build after the reporting release. This document describes the implementation; a draft pull request is not a production deployment.

## What changes

A foreman, supervisor, or owner can ask for a new job using a name and job code. Ask shows the supplied details and similarly named jobs. Nothing is created until the person presses **Create job**. The database returns the saved job link and remembers the action so retrying a lost response does not create another job. Customer details, dates, address, and notes are optional. Projected hours, goal hours, and square footage require supervisor/owner access, matching the existing labor-target controls.

New jobs start **Not ready**, and normal warehouse staging is created by the existing project trigger. The responsible supervisor still sets job readiness, assignments, and any other job setup in the job itself. Automation accounts cannot create operational jobs.

Supervisors and owners can ask for crew schedule drafts. A batch saves completely or refuses completely. People working the same job/day are grouped into one crew assignment. The review card shows the actual job, dates, times/notes if present, and crew. **Review / refresh availability** checks current job readiness, crew access, overlapping bookings, a foreman/lead, and pending/approved time off. Publishing requires a fresh review and only publishes the assignments in that card. Crew reminders are queued through the existing delivery system; queued does not mean received.

The same availability/readiness validation protects AI drafts published from the normal Scheduling board. Connected-plan assignments must still be published through their plan. Travel is not published by this action.

## Reliability and permissions

- Database action functions independently check the authenticated internal user's current role, retirement and access-revocation state. The on-site `active` flag is not account access.
- New reads and action calls use the caller's authenticated client. No new service-role action endpoint is exposed.
- Action receipts belong to their original caller and request content. Reuse with different content or a different caller is refused. Receipts follow the existing user-retirement deletion path and appear in its preview.
- Draft creation, audit records, receipts, publication, and reminder queueing are transactional. Normal scheduling writes and time-off changes share the same database lock.
- Publication checks current records again. If the reviewed assignments changed, the person must refresh before publishing. Repeated publication requests return the existing receipt without extra events or reminders.
- A new job is still shown as a proposal until a successful database response confirms it. A schedule draft is never described as published merely because the model says so.

## Boundaries

Chat cards live in page state. Save/download reports before leaving; saved jobs and schedule drafts remain in their normal app screens. Cards currently do not provide inline field editing: ask for a corrected proposal before creation, or edit the saved job / draft in its normal screen.

Scheduling context is a bounded planning snapshot, not an exhaustive staffing audit. Publication checks all selected records, but specialized skills, equipment, travel plans, and job-specific prerequisites still require supervisor review. This build does not implement automatic readiness decisions, payroll approval, saved salary exclusions, Hexcore knowledge ingestion, or full-app AI control.

## Verification

- `app/src/lib/askActions.test.ts`: input validation, permissions, and normalization.
- `scripts/verify-ai-actions.mjs`: runs the actual migration in disposable PostgreSQL with representative existing dependencies; exercises permissions, duplicate retries, rollback, absences, stale reviews, native-board publication checks, and notification deduplication. This is not a production migration replay.
- `app/e2e/ask-actions.spec.ts`: phone/desktop cards, no write before the creation click, retry with the same request, blocked publication, fresh review, and installer refusal. Fixture data only.
- `scripts/smoke-ask-actions-openai.mjs --live`: opt-in real-model checks with synthetic records; no app writes.
- Full app tests, build, lint, bundle budget, and Ask Deno type-check run before handoff. CI includes the database and browser checks.

## Try it

- “Create a job called Example House, code EXAMPLE-HOUSE, at 123 Example Street. Projected hours 200, goal 180.”
- “Draft Alex and River onto the Example job next Monday. Show me the schedule to review.”

Use real job/person names in Forge. The example does not create records by itself.

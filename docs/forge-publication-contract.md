# Forge publication contract — verified prerequisites

Read-only catalog inspection: September 7, 2026 (America/Denver), production project `czprjcskmzzagdztqonm`. Repository baseline `6ecbb59`. No business rows read or changed; no production mutation probe. Sources: `information_schema.columns`, `pg_policies`, `pg_class.relrowsecurity/relacl`, `pg_constraint`, `pg_proc`, and the eight latest migration-history entries. This is an implementation contract. The permission prerequisite now has a tested draft migration; nothing here is deployed.

## Verified state

- `schedule_assignments`, `schedule_assignment_members`, `schedule_events`, and `vehicle_project_assignments` have RLS enabled, authenticated write grants, and an ALL policy whose only restriction is `NOT is_partner_user()`. The UI's supervisor-only editing rule is therefore not enforced by these table policies for ordinary internal crew.
- `trips` and its child records restrict writes using `travel_is_supervisor()`. Trip and lodging read policies allow trip members without checking published status. Flight read policies allow any member of that trip without filtering the passenger. The UI's published-only and personal-flight filters must not be mistaken for server-enforced privacy.
- No assignment-to-trip foreign key exists in the inspected tables. `vehicle_project_assignments.assignment_id` already exists; reuse it instead of inventing a second vehicle booking store.
- No Schedule/Travel publication RPC appeared among public function names containing publish, schedule, or trip. `schedule_delivery` is an existing atomic delivery path; preserve it.
- Schedule publication updates selected assignment statuses, then writes best-effort events; Travel publication is separate. The missing-table Schedule fallback can mark a local record published. This cannot satisfy a server-acknowledged connected-plan contract.
- My Schedule associates one visible trip per project using a map. Project identity alone cannot identify the correct rotation when two trips serve one job.
- Latest observed migration-history identifier is `20261002000000` (`job_facts_lines`). These identifiers include non-calendar sequences. Refresh both master and deployed history immediately before allocating a migration; no number is reserved by this document.

## Required implementation order

1. Enforce existing product permissions at the database boundary. Separate SELECT from supervisor-plus mutation policies for schedule, membership, events and scheduled vehicle links. Preserve existing crew edits to plain job-level vehicle links. Preserve the partner wall, delivery RPC behavior, documented service-role jobs and foreman read access. Restrict draft trip details to supervisors; published crew access remains membership-based. Restrict passenger-specific flights to that passenger or supervisors, with whole-crew flights available to all assigned members. Audit attachment storage policy as well as metadata policy before claiming file privacy.
2. Add durable plan identity and explicit links. A plan contains selected assignment IDs and explicit trip IDs; a joining table permits multiple travel rotations per job. Never infer or backfill links from project/date proximity. Existing unlinked records keep their existing screens and require explicit selection to join a plan. Work dates and travel dates remain separate.
3. Introduce immutable publication revisions. Use a server revision counter on the plan, not client timestamps. Draft edits live apart from the crew's last published snapshot. Expected revision covers membership, trip children and vehicle reservations as well as the parent records. Removing crew revokes future instruction access; historical time and reports retain their original authorship.
4. Publish through one transaction with `plan_id`, `expected_revision`, and a unique request ID. Verify real authenticated role and partner exclusion inside the RPC. Lock plan and affected resources in deterministic order; validate membership, dates and vehicle conflicts; write selected revision, audit event and notification-outbox items atomically. A retry with the same request and payload returns the prior result; a reused request with different content or a stale revision fails clearly. Unrelated drafts remain untouched. A missing RPC or offline connection must leave a draft unsent.
5. Deliver notifications separately. Unique recipient/revision/channel keys prevent duplicates. Record pending/sent/failed delivery independently of published status. Retry delivery without republishing. Do not promise notification delivery merely because the database commit succeeded.
6. Connect both schedule and travel review entry points to this same revision preview. Show work days, travel days, crew, vehicles and changes since the prior revision. Preserve unsaved review state across layout changes. Refresh registered query roots for schedule, trips, My Schedule, vehicles and affected job views after acknowledged commit.

## Release gate

Prove policies with installer, foreman, supervisor, owner, partner and anonymous roles in a disposable local database or isolated authorized test environment; catalog inspection alone is not an execution test. Do not test writes against live crew records. Include draft privacy, personal flight privacy, removed crew, attachment URLs, duplicate clicks, retry after commit, concurrent child edits, two trips for one job, rotations, weekend/timezone boundaries, conflicts, cancellation, unrelated drafts and offline recovery. Exercise existing delivery creation as a regression test. No migration should be deployed as part of the presentation-only PR.

The display preference, day agenda and continuous trip sheet can be reviewed independently. Connected publication remains gated on this database work and its behavioral tests.

## Permission prerequisite implemented in draft

Migration `20261003000000_forge_workflow_permissions.sql` follows the September 8 read-only refresh and master `32b0620` (#592). It restricts direct Schedule writes, preserves crew job-level vehicle assignments, enforces trip publication/membership and passenger file privacy, protects the private attachment bucket and adds an explicit partner/role check to `schedule_delivery`. Existing travel editors, supervisor uploads and delivery create/reschedule behavior are preserved. The app removes foreman mutation entry points in all schedule views and explains scheduled vehicle ownership.

`scripts/test-forge-permissions.sh` passes against a disposable PostgreSQL 16 container using synthetic records and the original Schedule/Travel migration schemas. It applies the draft migration twice and checks real role reads and writes, membership removal, personal/whole-crew flights, cross-trip/malformed attachment references, object access, allowed management writes, plain vehicle links and delivery rescheduling. CI runs it independently. Production catalog inspection confirmed `trip-attachments` remains private. No production migration or business-data mutation has occurred.

Limit: this is PostgreSQL policy verification, not a restored full Supabase environment or Storage HTTP integration test. Already issued signed URLs remain usable until expiration (the current app requests one hour); downloaded/offline copies cannot be retracted by RLS. Do not describe removal as immediately revoking existing bearer links.

The durable plan links, immutable revisions, atomic publish RPC and notification outbox remain subsequent work under ticket 04. Refresh migration history and check competing branches again before deploying this draft.

## Connected-plan implementation in draft (September 8)

Migration `20261004000000_connected_workflow_plans.sql` adds explicit plan identity and assignment/trip links, a separate versioned JSON working copy, immutable publication revisions, request fingerprints, and a notification outbox. Initial linking only accepts selected, existing install drafts and trip drafts for one job. There is no project/date backfill and no effect on unlinked drafts. Work dates and travel dates are independent.

Schedule and Travel open the same phone review. A manager can edit work dates/time/notes/crew and travel name/destination/dates/timezone/notes/crew, inspect the existing travel pack, compare changes since publication, save a private draft, review conflicts, and publish the selected plan. Scheduled vehicle dates follow their work block. Vehicle conflicts block publication; crew overlaps require explicit acknowledgment. Expected revisions and a review token reject stale drafts or changed conflicts. Publishing materializes parent fields and membership, writes history/audit, and queues the union of old/new recipients in one transaction. Reusing the same request and fingerprint returns the committed result. Cancellation is another audited transaction, with its own retry identity.

Ordinary Schedule/Travel writes to linked records are guarded, including attachment storage mutations. The old standalone Schedule publish bar excludes linked assignments. My Schedule receives explicit named trip links, including multiple rotations; no link is inferred from proximity. New workflow query roots are not persisted offline. Missing schema hides connection controls, and new mutation RPCs have no local-success fallback. Existing unlinked workflows and their legacy fallback behavior remain intact.

`deliver-workflow-notices` is a separately deployed, authenticated manager-only Edge Function. It claims at most 20 committed notices per call, uses expiring leases, and records push acceptance separately from publication. Publication attempts delivery; the review exposes pending/failed counts and manual retry. It does not contain a background schedule. Push is at least once after an uncertain network outcome, with a stable notification tag; it is not proof a person read the instructions. A device without a subscription remains failed/pending. No real notices were sent during development.

The existing account-removal history count includes plan authorship, revision actors and notice recipients. The existing job-purge function retains its authorization and detach/purge order, first releasing plan links and detaching/canceling the plan. Immutable revisions remain available to managers; notices for a purged job are not claimable. No purge or account-removal operation was run against production.

### Deliberate first-version limits

- Flight, lodging, ground transport, trip-specific instructions, contacts, files and vehicle identity are read-only after connecting. Complete them in their existing editors before linking. A never-published plan can be disconnected to edit them; a published plan cannot. Full working-copy authoring for these details remains future work. Shared company-wide procedure templates continue their existing independent lifecycle.
- All trips in an explicitly selected plan are linked to each selected work block; membership limits which links a crew member receives. The model does not infer per-person rotations or automatically assign a specific trip to a subset of work blocks. Select plans accordingly.
- New table/function permissions are tested in isolated PostgreSQL, not through a restored production Supabase stack. Storage SQL guards are exercised; Storage HTTP behavior and real-device push delivery still require rollout validation. Existing downloaded copies and signed URLs retain the limitation above.
- Source rows changed through administrator/definer access outside the plan cause publication to stop for reconciliation. The review does not offer an automatic overwrite or a source-reconciliation tool.
- A short advisory lock serializes Schedule/Travel writes, publication and storage metadata changes. Conflict SQL disables JIT for its bounded JSON review. Production load behavior has not been benchmarked.

### Rollout remains gated

Refresh master, migration history, competing PRs and backend drift immediately before rollout. Deploy the permission migration first, then the connected-plan migration and notification function, and validate an authorized isolated plan before enabling this for live crews. The owner must approve merge/deployment. Existing live security drift from the unapplied permission migration is not waived by these tests. Draft PR #591 contains the reviewable implementation; nothing in this section authorizes a production mutation.


### Remove one day from an unlinked assignment

Scheduling now lives under People. In Edit assignment → Remove, the default is
**One day only** with a date picker (prefilled from Agenda, Week, or the day
panel). **All days in this assignment** remains a separate explicit choice.
A middle-day removal splits the assignment into two blocks; edge removal trims
its range. Both remaining blocks retain status, publication time, crew roles,
notes, start time, color, AI origin, and their vehicle bookings. The selected
day is removed for everyone on that assignment. Other assignments and trips
are untouched. Connected plans continue through their existing review boundary;
this command cannot bypass it or edit delivery appointments.

Migration `20261005000000_remove_schedule_day.sql` adds an invoker RPC using the
existing manager/partner policies, connected-plan guards and publication lock.
Date changes, member/vehicle copies and audit commit together. A stale timestamp
is rejected; retrying an already removed day does not remove another day. There
is no client-side multi-write or local-storage fallback. Install the migration
after the existing permission/publication prerequisites before exposing the UI.
Existing best-effort schedule-change notifications remain separate from the
transaction. Synthetic PostgreSQL tests cover split/trim/delete, retry, stale
edits, role denial and audit-failure rollback; browser fixtures exercise both
removal choices and visible errors at 375px and 1280px.

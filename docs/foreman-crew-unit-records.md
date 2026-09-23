# Foreman crew unit records

Foremen, supervisors and owners can open **Record crew work** in Current Work or a job’s Custom Data. They can select a saved unit, select a map opening (which keeps its map identity), or build a unit with the existing unit builder. They select one or more active internal crew members, the actual work date, stage, status and optional spoken/typed notes. No job clock or unit timer is required to file the record.

Statuses distinguish an assignment for future work, partially completed work, and a completed stage. Completing the Installing stage offers an explicit **Entire installation finished (all visits)** checkbox. This updates the custom unit’s completion fact, not the legacy map’s installation/QC workflow. An RO check, flashing or hardware entry never silently completes the entire unit. Map status, QC approval, measured sessions and payroll punches remain unchanged. The ordinary install sheet also now exposes its existing one-person credit picker to foremen on unassigned and self-assigned openings.

## Data and reliability

- The shared custom-work queue saves the payload under the signed-in account before sending. Queued or refused records remain visible and recoverable through the existing queue controls. This uses the existing queue and does not claim to fix all app-wide offline problems.
- `record_crew_work` validates the caller and selected people server-side. Partners, inactive callers and ordinary installers cannot file on behalf of crew. Installers can read the same job-scoped records as the existing Custom Data area.
- The unit mutation, crew record, people, history and idempotency receipt commit in one transaction. Repeated requests use the original command ID and cannot create a second report. Different payloads cannot reuse that receipt. Existing-unit revision checks reject stale edits.
- Existing map openings are reused. Duplicate new names within the job are refused with instructions to select the existing unit or distinguish a different unit by floor/building.
- Records keep the person who filed the report separate from the people credited and the work date separate from the submission timestamp.
- Retrospective attribution has no measured labor duration. Units with any untimed reported work are excluded from pricing samples, even when some other visits were timed. A future reviewed reconciliation feature would be needed to restore sample eligibility.
- Account-removal history counts include crew attribution. Records follow the existing job and unit deletion cascades. Profile removal preserves the record until the existing retention process ultimately removes the profile; participant links then cascade and the filer becomes null.
- This is a historical assignment/work ledger, not an exclusive unit reservation system. Changing an earlier crew entry is not included; a foreman can add a follow-up record explaining a correction. Original records remain visible.

## Release and verification

Apply `20261023000000_foreman_crew_unit_records.sql` before deploying this frontend. The migration is additive: it creates the ledger and participant tables and adds an untimed-work flag. It does not import or rewrite existing timecards. The release note is limited to foreman, supervisor and owner audiences.

Checks include the actual new and existing custom-work migrations in disposable PostgreSQL, caller/partner/participant rules, replay and stale-edit refusals, map identity, job-deletion visibility, explicit completion and unchanged payroll/session tables. Auth and sandbox infrastructure in that SQL harness are fixture stubs; repository sandbox checks provide additional static coverage. Browser fixtures cover phone/desktop layout, two-person filing without a clock, reload persistence, connection failure/retry and installer visibility. These are local fixtures, not physical iPhone or live-business-record tests.

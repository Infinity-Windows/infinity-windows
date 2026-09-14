# Job labor targets, stages, and cost-code stats

The job overview now supports an optional whole-job labor estimate and a separate foreman goal. Analytics adds all-time crew clock hours, worker cost-code/job detail, and a job comparison with SQF, recorded hours, expected hours, goal, and completed-job variance. Existing unit estimates, clocks, payroll, and install points are unchanged.

Confirmed stage order: Material Delivered; Material Onsite; RO's Checked; RO's Flashed; Frames Set; Glass/Doors Installed; Hardware Installed; Detail Work; QC Passed; Customer Approved. Stages are independent manual records with a completion note/reopening reason. The bar reports completed stage count, not an invented weighted percentage, and does not change the job lifecycle status or award points.

## Data and access

Apply `20261009000000_job_labor_and_stages.sql` before making the feature available in production. It adds internal targets, stage progress, and append-only execution history. Every table has RLS and a partner exclusion, with the existing sandbox fence attached. Foremen and above read/change stages; supervisors/owners set labor targets through an RPC. Target/stage writes use expected revisions and parent-row locks. Client table writes are revoked. These records cascade only when their parent job is purged; they are hidden while it is trashed.

The new tables are not included in STG projections. STG portal/warehouse work is a separate change. Its confirmed scope is STG-related jobs and inventory only.

The New project flow is preserved. After creating a job, open its Overview and choose **Set / edit labor targets**. Targets are optional and can also be added to existing jobs. Failure to load the target schema is surfaced as an error, not silently treated as saved/zero targets.

## Calculation conventions

- All job labor categories count, including travel, warehouse work, and corrections. Totals use submitted/approved closed time shifts less recorded breaks.
- Open shifts are counted separately and do not accrue into this report. Rejected/needs-finish shifts remain review counts, not accepted hours. Voided shifts are excluded.
- Worker/job days are distinct Mountain-time clock-in dates. Historical workers remain visible; active crew with no recorded time show zero. Stats exclude testing jobs.
- Unit timers/daily logs are not added to clock hours. Existing install-based analytics remain separate.
- Score is `(recorded - projected) / projected * 100`, only for completed jobs with recorded hours and a positive estimate. Negative means under the estimate. The goal remains a separate figure; 190 actual against 200 estimated and 180 goal is 5% under estimated but 10h over goal.
- Missing SQF/targets render unknown. SQF is optional manual entry; automatic area derivation and the exact area convention still need confirmation.
- All-time reads paginate, use exact counts, and reject incomplete reads. This is not a transactional multi-query historical snapshot: edits during loading can require refreshing. At large scale, move aggregation server-side rather than expanding raw downloads indefinitely.

## Pending product decisions

No automatic whole-job bonus awards: amount, recipients, acceptance gates, and treatment of later corrections must be defined first. The stage order is confirmed, but document-specific checklists, required photos/signatures, optional steps, and area-specific partial progress are not implemented. Units analytics are deferred. Custom date filters are not included in this first all-time report. New labels follow the existing English Analytics/job-overview screens; translation is not included in this slice.

## Validation and release boundary

Unit tests cover reconciled hours, missing codes/jobs, duplicate shifts, review states, Mountain days, paging, targets, variance, and deletion registration. Playwright fixtures exercise target writes, stage completion, worker detail, responsive layout, and partner routing. `scripts/verify-job-execution.mjs` runs permission, validation, stale-revision, audit, and cascade checks in disposable PGlite; existing auth/sandbox helpers are stubbed, so it is not a proof of the complete production schema. `scripts/test_sandbox_guard.py` checks the real migration attachment contract.

This change requires production migration and authenticated smoke verification before it can be called live. Do not apply production migrations from the isolated test harness.

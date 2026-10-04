# Work Data snapshot (read-only bridge)

`work_data_snapshot(p_project_id, p_from, p_until)` (migration
`20261107000000_work_data_snapshot.sql`) and `fetchWorkDataSnapshot` /
`validateWorkDataSnapshot` (`app/src/lib/workData/api.ts`) are a read-only
bridge from existing evidence tables into the typed payload
`app/src/lib/workData/reconcile.ts` projects over. **Nothing here writes
payroll, capture state, or QC.** No new activity taxonomy is invented —
every `label`/`activityId`/`scope` below is a direct readback of a stored
field.

## Why a new RPC, not the existing client reads

`time_shifts` (`20260950000000`) and `custom_work_sessions`/
`custom_work_history` (`20261011000000`) are readable by **any signed-in,
non-partner crew login** on a visible job — broad enough for the screens
that already exist (DataHub's per-person breakdown is gated by a UI toggle,
not RLS). Assembling many people's raw rows into one reconciliation payload
must not depend on a UI toggle for its privacy. `work_data_snapshot`
re-checks `custom_work_internal()` and `_is_supervisor(auth.uid())` itself,
in SQL, before any source table is touched, and gates the project with
`_ai_job_visible`: QA identities are confined to sandbox projects; real supervisors/owners retain the existing nondeleted-project visibility, including testing projects. Deleted projects are refused. Breaks are already deducted by
payroll (`shiftHours`); this function does not deduct them a second time —
it reports `breakSeconds`/`breakStartedAt` for `reconcile.ts` to place.

## Source-to-claim mapping

| Source | Included when | `scope` | `unitId` | `rework` |
|---|---|---|---|---|
| `custom_work_sessions`, `kind='unit'` | source shift and person match, all source/current unit/opening jobs visible | `specific` | `opening:<id>` if the linked `custom_work_units.opening_id` is set, else `custom:<unit_id>` | `outcome = 'rework'` |
| `custom_work_sessions`, `kind='idle'` | source shift and person match, all source/current unit/opening jobs visible | `general` | `null` | `false` |
| `unit_sessions` | opening is authorized/nonremoved; interval intersects a selected same-person shift or begins in the requested timestamp window | `specific` | `opening:<opening_id>` | `is_rework` |
| `task_sessions` | `state = 'on_task'` only — `off_task` and `break` rows are **excluded**, not relabelled; an excluded interval is left for `unknownSeconds` to cover, never invented as an "other" claim | `specific` | `opening:<opening_id>` or `null` | `false` |
| `service_time_sessions`, `kind='unit'` | the linked unit's opening (if any) is nonremoved | `specific` | `opening:<id>` if the service unit links one, else the custom unit's own canonical id, else `service:<service_visit_unit_id>` | `true` — servicing is marked rework/servicing per the brief |
| `service_time_sessions`, `kind='idle'` | source shift and person match, all source/current unit/opening jobs visible | `general` | `null` | `false` |
| `service_time_sessions`, `kind='travel'` | source shift and person match, all source/current unit/opening jobs visible | `other` | `null` | `false` |

`label`/`activityId` are the stored `stage`/`description` text verbatim
(prefixed only to namespace by source kind, e.g. `unit:Installing`,
`idle:Gathering`) — never reclassified into a new vocabulary.

Claims are matched to a shift by `reconcileShift` itself
(`shiftId === shift.id`, or an unlinked same-person/same-project interval intersecting the shift) — `unit_sessions` and `task_sessions` carry no `shift_id` column,
so they use same-person, same-project interval intersection. Explicitly linked sources preserve their original bounds, including authorized project mismatches. The report is not a comprehensive orphan-work audit.

## Untimed evidence

`opening_phases` (flashing minutes, which are a paused-clock aggregate and
are **never** turned into a guessed start/end range), `install_events`
(legacy hand-typed minutes), and `crew_work_record_people` (named
attribution with no duration at all) are returned as `untimed` rows:
`{ sourceId, sourceTable, profileId, projectId, unitId, activityId, label,
workDate, reportedSeconds }`. `reportedSeconds` is `null` whenever the
source has no minutes (always true for `crew_work_record_people`).

## SnapshotUnit: what is honestly null in this first slice

`category` and `subtype` are **always null** — neither `custom_work_units`
nor `project_openings` independently establishes a taxonomy; `type_label` is
free text a foreman typed, and turning it into a structured `subtype` would
be exactly the kind of guess the brief forbids.

`dimensionsVerified` is **always false** and `qcAccepted` is **always
false** in this slice. Real width/height/material/floor values ARE surfaced
(from `custom_work_units.facts`) when a custom unit carries them, but
"verified" is never derived from their presence, and no `qc_checks` read
happens here at all — accepting or rejecting a unit stays the QC screen's
job. `hasUntimedEvidence` reflects `custom_work_units.untimed_work_present`
or the presence of a matching `untimed` row.

## Break placement

This bridge does **not** expose raw `time_clock_actions` (server-only, per
the brief) and does not infer a break's position from a gap in recorded
work. It returns exactly what payroll already has —
`breakSeconds`/`breakStartedAt` on the shift — and `reconcileShift`
(existing, Codex-owned) is what decides whether known break *intervals*
(from `EvidenceBreak`, not produced by this RPC in this first slice) line up
with that deduction. A closed shift with a nonzero scalar break deduction and no exact break intervals keeps its whole net paid pool unknown. Zero-break shifts can classify exact paid claims; a running break has its existing explicit timestamp. No completed historical break is guessed — this is the documented limitation the brief asked to
be disclosed, not a bug to fix here.

## Bounds, validation, and what refuses rather than truncates

- Non-null `p_project_id`/`p_from`/`p_until`; `p_until > p_from`;
  window ≤ 93 days.
- `custom_work_internal()` and `_is_supervisor(auth.uid())` both true, and
  `_ai_job_visible(p_project_id, auth.uid())` true — all three checked
  before any `time_shifts`/`custom_work_*`/`unit_sessions`/`task_sessions`/
  `service_*`/`opening_phases`/`install_events`/`crew_work_records` read.
- Each of shifts/claims/units/untimed is capped at 10,000 rows; exceeding the cap
  **raises an exception** (refuses) rather than silently returning a
  truncated page as if it were complete.
- `app/src/lib/workData/api.ts`'s `validateWorkDataSnapshot` re-validates
  the whole shape client-side: every identity, enum, timestamp and number is
  checked; shift ids, claim `sourceId`s and unit ids must each be unique;
  the returned `project.id` must equal the requested `projectId`. A
  malformed or missing RPC throws `WorkDataUnavailableError` — it is never
  read as a successful, empty snapshot.

## Auth binding

`fetchWorkDataSnapshot` follows `app/src/lib/work/startShift.ts`'s exact
pattern: a `signInMark()` taken before `getSession()`, `stillSignedInAs`
re-checked both before building the request and after the RPC resolves, and
the RPC itself sent on `clientWithToken(session.access_token)` — never the
ambient, session-following client — so a reply that lands after a sign-out
or account switch can never be attributed to the account that is signed in
now.

## Known gaps / remaining questions for the next slice

- No completed historical `EvidenceBreak` source is produced yet. Nonzero scalar break deduction without placement makes the net paid shift unknown; zero-break shifts still classify source intervals.
- Source chains are checked before any identifiers/counts: original activity/report project, selected shift person, current custom unit and mapped opening, and service visit/unit/project access. Missing/hidden linked sources are excluded before projection; their payroll remains unknown rather than receiving invented attribution.
- `install_events.installer_id` is the only accepted attribution; the
  free-text `installer` column (a typed name with no profile) is
  deliberately excluded, matching "named-only helper evidence" rather than
  inventing a profile match.
- This migration and probe were written against the `project-work-data`
  worktree's schema as read (baseline `b7d8f556`'s lineage, branch
  `codex/project-work-data-20261003`) but were **not executed against a
  real database** — no Bash/SQL execution tool was available this session.
  `scripts/dry-run-probes/work-data-snapshot.sql` is prepared for the
  existing `db-dry-run.yml` harness to run; it has not been run here.

## UI and evidence basis

New-design `/data` is the private read-only report; Classic `/data` retains DataHub. `/summary` preserves all existing reports/filters/ledgers. Both destinations keep the supervisor floor. Named queries are in-memory only (`offline:false`, `gcTime:0`), cancelled and discarded on viewer/preview/offline boundaries. Token-bound responses cannot populate another sign-in.

Unit aliases and facts reflect the authorized current mapping, not a reconstructed historical fact revision; original source IDs remain visible. Trusted cohorts exclude estimated/unverified dimensions, incomplete/unaccepted final QC, rework, untimed or missing attribution, unapproved/provisional payroll, unknown coverage and source exceptions. General overhead never receives a unit-area denominator. The matched cohort numerator and denominator use exactly the same eligible unit IDs.

Timestamp windows use absolute instants and include whole shifts whose clock-in is in the window. Date-only retrospective work and timestamp work-date labels use `America/Denver`; intersecting calendar dates are included without claiming second-level precision. Planned `assigned` crew records are excluded. Server-confirmed open activities are not labelled as phone-pending.

`verify-work-data.mjs` executes the actual migration over populated disposable fixtures, including hidden/relinked source chains and null facts. Its permission helpers are fixture substitutes. Real-schema candidate-bound rollback probe remains mandatory before merge.

# Plan and Workday phases 5 and 6

Recent activities opens from Work for foremen and above. Team, Roster, Custom Data and the new Data view also link there. It reads saved Workday sessions and units and shares the audited correction command and queue with the job's work timeline. The correction migration prevents an older done tap from restoring a superseded outcome. Original activity, actor, and reason remain in the correction history. Paid time remains in the timecard workflow.

| View | Source and purpose |
| --- | --- |
| Current and classic Data | Live job, session, install, and shift readers. Existing lost-time, payroll-cost, estimate-quality, and data-quality reports still serve a distinct purpose. |
| Proposed | Saved Workday sessions and custom units reconciled with legacy installation, phase and task sources. Includes unit-first records, source inspections, charts, and held evidence. Recorded machinery appears beside activity duration when the report window contains the session. |
| Evidence | The work_data_snapshot RPC reads saved claims, shifts, unit facts, and untimed evidence. SQL enforces supervisor and owner access. |
| Pilot | Labeled sample HTML with fabricated data. Its design interaction is local. |

Keep all four views for comparison. Review Proposed alongside Current for the same job and period before retiring any tab. Data can be reviewed independently with saved historical records. Ammon already has owner access. The Workday walkthrough simulator and training helpers are separate from the saved reporting sources. Report queries are account-scoped and held in memory.

Daily logs prefill from the signed-in installer's sessions for the job and day. Offline drafts use the saved copy and mark queued changes. The shared log, revision checks and submission queue still govern filing. Capture uses the existing sheet and actions. It moves out of the desktop sidebar into the bottom dock and keeps its center action on phones.

The company New Design Release 1 switch and per-profile classic/new setting control the Steel front door and Data routing. Embedded Workday also depends on Plan and Workday migrations. Capture and clock-out daily-log prefilling are shared shell changes outside that switch.

Before release, compare the applied Supabase migration IDs against the Plan and Workday chain, including 20261130030000 for machinery and completion metadata and 20261130070000 for correction replay. The rollback probe is scoped to FORGE-TRAIN-1103 and the TEST installer. Live read and migration verification remain pending.

Fixture checks cover the correction command, offline replay, the same corrected record in the clock-out draft and Proposed Data, and Capture on phone and desktop. Hosted row coverage, database permissions, and applied migration IDs remain unverified.

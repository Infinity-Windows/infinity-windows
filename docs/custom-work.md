# Current Work and Custom Data

This build adds a fast field-capture route at `/current-work` and a `Custom Data` tab to data-mode and tracking-mode jobs. It is an additive feature: the existing payroll clock, map, unit installation workflow, photos, QC and points remain available.

## Crew workflow

An open job clock makes the ordinary home route show Current Work. Explicit job/map links still open their requested destination. Off-clock users retain their previous home and can open Current Work from the menu.

1. Clock into the job through the existing clock and safety process.
2. Tap **Start unit**, enter a number and type, and start. Unknown type, a generated temporary name, missing dimensions and an unassigned job are supported.
3. Add dimensions, story, location, material, electrical components, complexity, access, approximate weight, equipment and its minutes, helper names, and notes when convenient. Types accept arbitrary text; the shared catalog is a suggestion, not a gate.
4. Each helper joins on their own account and records their own interval. Entering helper names alone creates no hours.
5. Tap **Unit complete ✓** to stop the timer as finished and mark the whole install complete (someone working another person's unit gets **Finished my part ✓**), finish into **Prep time** with a preset or typed description, switch to another unit, or stop. Breaks and clock-out end the active interval. Returning from a custom-work break requires a deliberate Start/Join.
6. Use the job's Custom Data tab to review the crew timeline, correct records, export CSV, and inspect candidate hours/SQF by type.

Foremen and above can add, rename, archive and restore reusable types. An installer can edit their own unit and their own accomplishment notes; foremen can edit the shared records. Foremen may correct closed activity intervals with a reason after the job clock is resolved. The server checks shift bounds, overlaps, job attribution and total captured time against the worked shift. These corrections never rewrite payroll.

A map selection carries its stable opening ID, label, and available type/dimensions to the form. Office specifications remain separate from captured facts. A mapped opening has only one custom record; helpers join it. An unmapped active record can be attached to a map opening that does not already have a custom record. Custom references also protect their openings during plan re-extraction.

## Data and authority

Migration: `supabase/migrations/20261011000000_custom_work.sql`.

- `custom_work_units`: field unit identity, optional job/opening, observed facts and revision.
- `custom_work_sessions`: one person's unit or idle interval linked to the original shift.
- `custom_work_types`: reusable type suggestions.
- `custom_work_history`: actor, reason, before/after values for commands and completion reopen events.
- `custom_work_commands`: private retry receipts; no client read/write grant.

Authenticated reads require an active internal crew identity and exclude partners. Unassigned records are restricted to their author/worker and foremen. Writes go through `custom_work_command`, which checks the real identity, revisions and command IDs. Shared edits cannot silently overwrite a newer revision. Retry receipts prevent a repeated delivery from creating another interval.

Custom activity transitions share a per-person database lock with legacy unit/task starts and flashing resumes. Starting custom work closes legacy unit/task activity and pauses the worker's flashing timer. Going back through a legacy entry point ends custom activity. The existing break-resume trigger does not revive an unrelated historical legacy unit after a custom-work break.

Assignment changes update captured attribution and flag mismatches with the original shift. They never move the payroll shift. Rejected/voided/changed shifts flag affected capture for review. Private tables are included in schema/merge, deletion-history, project cascade and sandbox registries.

## Offline behavior

An account-specific durable queue saves before the UI shows a new local timer. It preserves command IDs and timestamps through reload, uses browser locks across tabs, and checks the signed-in account before sending. Pending work is included in the global sync indicator. Conflicts stop the queue, keep the payload, and offer retry or export for recovery. Removing refused pending changes requires an export and an explicit local confirmation.

An existing synchronized job clock is required to begin unit timing. A brand-new job clock that is itself still in the old offline outbox must synchronize first; unit details can be saved in the meantime. This build does not repair the old clock outbox's replay-time semantics. Old or conflicting intervals are retained for review rather than silently backdating payroll.

## Reporting boundaries

One physical unit contributes area once, even across multiple visits or helpers. Hours are combined per worker using interval unions. Width and height use outside-frame inches; SQF is width × height ÷ 144. Starting another visit reopens the whole-install completion flag, with history.

Candidate hours/SQF require an assigned job, positive dimensions, a known type, explicitly completed whole installation, closed valid shifts, and no open/flagged/implausibly long activity. Units with older legacy tracking time are excluded because this report only totals custom capture. Helper names, measurements and scope still need human verification before a price is set. Idle hours are separate, and no automatic dollar price or bonus is calculated.

This release does not import legacy activity, merge two already-created physical-unit records, reconcile every shift minute into an unallocated-time report, or add custom-record photo attachments. The existing job Photos tab remains available. Those are follow-on improvements, not represented as completed here. Main actions have English/Spanish labels; the new detailed form is currently English.

## Verification and release

Run with Node 22:

```sh
cd app
npm test
npm run lint
npm run build
npm run budget
IW_MAP_PORT=5198 npm run e2e -- custom-work.spec.ts
```

The SQL harness runs the actual migration/RPC/trigger code in disposable PGlite. Existing auth, shift helpers and sandbox attachment are fixture stubs; it is not a full Supabase migration replay or a production authorization smoke test.

```sh
PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js node scripts/verify-custom-work.mjs
python3 scripts/test_partner_wall.py
python3 scripts/test_sandbox_guard.py
python3 scripts/test_schema_verify.py
python3 scripts/test_supabase_merge.py
```

CI includes both the fixture browser tests and the disposable database checks. No production data or test-account status was changed during the build. Before release, review the migration in the existing deployment pipeline and run an authenticated small-crew pilot. Verify a real map selection, helper timing, break/clock-out, disconnected reload and a foreman correction. Keep test activity scoped to the authorized test job. The pilot and production release remain outstanding.

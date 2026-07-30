# Three install timers that ran for 300+ hours — cleared 2026-07-30

Production project `czprjcskmzzagdztqonm`. Approved by Taylor before the change
was made. This file is the permanent record of what those three stamps were,
because `project_openings` has no free-text note column that could hold it
without side effects (see "Why the note isn't on the row" below).

## What was wrong

The Heartbeat "Live crew" list reads *install* timers on individual windows —
`project_openings.work_started_at` — not the time clock. Three of those stamps
had never been finished, so the list showed installs that had been "running" for
days. Nothing on the server ever retired a stamp, and Live crew fed it straight
into a live counter.

## The three rows, exactly as found (before)

Read from production at 2026-07-30 21:09Z. Every other column on these rows is
listed so it is provable that nothing else was touched.

| | OAKRIDGE C101 | OAKRIDGE C103 | PECAN14 1-1 |
| --- | --- | --- | --- |
| `id` | `503a7c1a-4887-471d-b861-dfcc3d22f731` | `6ec5ab5e-9319-46f1-a8bd-1e070f70f642` | `e2abaf14-79cb-4bc4-84ac-1df568014f23` |
| job | Oakridge Apartments Bldg C | Oakridge Apartments Bldg C | Pecan Valley Town Homes — Bldg 14 |
| `label` | Unit C101 living | Unit C103 slider | *(none)* |
| `work_started_at` | `2026-07-17 06:05:21.809172+00` | `2026-07-17 06:06:56.997869+00` | `2026-07-18 04:22:43.872058+00` |
| running for | ~327 h | ~327 h | ~305 h |
| shown as | Taylor | Unassigned | Unassigned |
| `status` | `planned` | `planned` | `planned` |
| `work_ended_at` | null | null | null |
| `assigned_to` | Taylor (`958d3bfc…`) | null | null |
| `removed_at` | null | null | null |
| `flag_note` / `flagged_at` | null | null | null |
| `ro_width_in` / `ro_height_in` / `ro_measured_at` | null | null | null |
| `condition` | `unknown` | `unknown` | `unknown` |
| `sequence` | null | null | null |
| `assigned_window_id` | null | null | null |

The two OAKRIDGE stamps are **95 seconds apart** at ~06:05Z, which is somebody
tapping through the app rather than two installs beginning at dawn.

## Why they were safe to clear

Checked directly rather than taken on trust. Every table that can hold work
against an opening was empty — both for these three specifically and across the
whole database:

| table | rows for these 3 | rows in total |
| --- | --- | --- |
| `install_events` | 0 | 0 |
| `task_sessions` | 0 | 0 |
| `qc_checks` | 0 | 0 |
| `issues` | 0 | 0 |
| `service_cases` | 0 | 0 |
| `project_opening_pin_moves` | 0 | — |
| `points_ledger` | — | 0 |
| `installer_category_stats` | — | 0 |
| `installer_type_stats` | — | 0 |

Every opening on every job (155 across BLACK22, OAKRIDGE, PECAN14, ZZTEST) was
still `planned`, with zero installed. So no pay, points, QC or progress figure
depended on these stamps.

## What changed

`supabase/migrations/20260731000000_stale_install_start_cleanup.sql` sets
`work_started_at = null` on openings past the eight-hour cap, stated as a rule
rather than as three ids so re-running it is a no-op. It refuses to touch a row
that has a finish time, an `installed` status, any install event, task session or
QC check, or that is hidden by the PR #214 soft delete.

Nothing else was written. No row was deleted, and no `status`, assignment, pin,
measurement, condition or flag was altered.

## Why the note isn't on the row

`project_openings` has no equivalent of `time_shifts.edited_note`, which is where
the runaway-shift guard (PR #218) left its reason. The one free-text column,
`flag_note`, is load-bearing: it becomes an open row in the `issues` view, and
`DispatchBoard` pulls a flagged window out of the assignable columns until the
flag is resolved. Writing an audit note there would have changed issue counts and
job screens — the exact thing this cleanup was required not to do. The record
therefore lives in this file, in the migration's own comment, and in the PR.

# Spec: Sessions — the stored atom of per-unit time

Status: ready-for-agent
Produced by Session 4 (grill, 2026-08-16). Vocabulary per `CONTEXT.md`. Ten decisions grilled; two owner overrides (no phased rollout — the app has never shipped to installers, ADR-0003; break-end auto-resumes the held unit). Facts verified against the live code by two recon agents; the load-bearing ones are restated inline.

## Why now (verified facts)

- Today's per-window number is `install_events.minutes`: **client-sent verbatim**, hand-typed beats the timer, no server check.
- **Breaks never touch the install clock** — a lunch mid-install inflates the window's auto minutes unless hand-corrected.
- **Walk time lands nowhere**: "carry-start" is tap-time (the next window's clock starts when its sheet mounts), so transition minutes vanish into the gap.
- `task_sessions` is a ghost: nothing reads it, and function rewrites silently dropped its break writes months ago.
- `clock_out` cleans only the payroll shift; dangling task rows and paused phase clocks leak.

Sessions fix all five structurally. And because **no installer has the app yet**, this ships as the first flow they ever learn — no migration, no dual-write, no coexistence (ADR-0003).

## Schema

```sql
create table unit_sessions (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references project_openings(id) on delete cascade,
  profile_id uuid not null references profiles(id),
  role text not null default 'install' check (role in ('install', 'helper')),
  -- Derived AT INSERT from an open redo on the unit — never set by hand.
  is_rework boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason in
    ('finish', 'block', 'break', 'clock_out', 'handoff', 'complete', 'auto_closed')),
  block_reason text,                                  -- only when end_reason = 'block'
  block_issue_id uuid references project_issues(id),  -- linked or auto-created
  created_at timestamptz not null default now()
);
-- The session follows the human: one open session per person, ever.
create unique index unit_sessions_one_open on unit_sessions (profile_id)
  where ended_at is null;
create index unit_sessions_opening_idx on unit_sessions (opening_id);
```

**Timestamps only — no minutes column** (Q2; standing decision: aggregates always derived). Minutes = `ended_at − started_at`, capped 480 at read. RLS: reads authenticated, writes RPC-only (house pattern).

`unit_redos` (Q4, the Redo button):

```sql
create table unit_redos (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references project_openings(id) on delete cascade,
  pressed_by uuid not null references profiles(id),
  reason text not null,
  pressed_at timestamptz not null default now(),
  resolved_at timestamptz                             -- stamped by the next finish
);
```

## RPCs (all security definer, house pattern)

- **`start_unit_session(p_opening_id, p_role default 'install')`** — gates: open shift + today's toolbox (same as today's start gate) + flashing not outstanding for role `install`. Ends the caller's open session first (`end_reason 'handoff'`). Sets `is_rework` from an unresolved `unit_redos` row. Keeps stamping `project_openings.work_started_at` (coalesce) so the map/Heartbeat read-model stays true.
- **`finish_unit(p_opening_id, p_next_opening_id, …submit fields)`** — evolves `submit_install_event`: same photo/grade gates, then ends the session (`'finish'`), resolves any open redo, and — **the chain (Q9-adjacent)** — immediately starts a session on `p_next_opening_id` *in the same transaction*, so transition time accrues to the incoming unit with no client round-trip. Suppressed when the FINISHED unit's signature has `tiers.length > 1` (dormant until Studio models tiers) or when `p_next` is null.
- **`block_unit(p_opening_id, p_reason, p_issue_id?, p_next_opening_id?)`** — ends the session (`'block'` + reason). Links the given blocker issue or **auto-creates one** (Q3 — one accountability record). Then chains to `p_next` exactly like finish (Q9): one hand-off behavior to learn.
- **`reattribute_session(p_opening_id)`** — the 5-minute grace (Q5): moves the caller's OPEN session (and its `started_at`) onto a different unit; refuses past 5 minutes of session age.
- **Hooks in existing RPCs (Q8 — the server owns closing):**
  - `start_break` → end open session (`'break'`).
  - `end_break` → **auto-start a new session on the held unit** (the caller's most recent `'break'`-ended session's opening, if that unit is still uninstalled) — owner override Q10: a minute or two of walk-back inflation accepted for zero friction.
  - `clock_out`, `_close_dangling_shift`, `finish_shift_at`, `close_shift_as_no_work` → end open session (`'clock_out'`).
  - `answer_summon` → starts a `role 'helper'` session (Q6); `complete_summon_help` / `close_summon` end it (`'complete'`). `summon_helpers` stays as the summon bookkeeping; sessions become the time truth; old helper rows backfill into evidence once at migration.
- **`press_redo(p_opening_id, p_reason)`** — any authenticated installer, reason required. Inserts `unit_redos`, flips the opening back to open work (status `assigned`, `confirmed false`, `work_ended_at` null — the ORIGINAL install_event stands, unlike undo). Client fires the foreman push. Un-submit (`undo_install`) is untouched — voiding a wrong record and redoing a real install stay different buttons (Q4).
- **Stale sessions (Q2):** `start_unit_session` and `clock_in` auto-close any open session older than 16 h (`'auto_closed'`, flagged) — a dead phone never becomes a 14-hour window.

## Field UX (the first flow installers learn — ADR-0003)

- **Finish** = today's capture flow, ending with "Finished — clock's now on ⟨next⟩" and the **5-minute banner**: "Clock's on window 13 — change?" → unit picker → `reattribute_session`.
- **Block** = big red alongside Finish: four preset reasons (*Missing hardware · Wrong glass · Opening not ready · Waiting on equipment*) + Other-with-text, existing blocker issues offered for linking, then the same hand-off banner.
- **Break-end**: "Back on window 14" confirmation toast — the session already restarted itself.
- **Redo** on installed windows: reason sheet → foreman push → window back on every list wearing a redo badge (map: assigned/waiting color + badge).
- Blocked units surface on Dispatch (derived: last session ended `'block'`, no later session) with reason + issue link.

## Derived numbers (nothing stored)

- **Labor-minutes(unit)** = Σ all sessions (install + helper) + flashing phase minutes (sibling record).
- **Install evidence(unit)** — feeds `EvidenceSource` in `lib/estimate/cohorts.ts` — = Σ sessions where `role in ('install','helper')` and `is_rework = false`. Blocked time is excluded *structurally*: no session runs while a unit sits blocked. Rework rate = units with any `unit_redos` / units finished.
- `install_events.minutes` stops being trusted: `finish_unit` stores the session-derived figure server-side; the client's hand-typed override is gone.

## Acceptance

- One open session per person is a database invariant, not an app behavior.
- A lunch break can never add a minute to any window (break ends the session; auto-resume starts a fresh one).
- Finishing window 12 and walking to 13 puts the walk on 13's clock with zero taps.
- Blocking auto-creates/links the blocker issue; the blocked window shows on Dispatch within a refetch.
- Redo never touches the original install record; undo still voids it. Different buttons, different truths.
- The cohort ladder's evidence swaps to sessions by changing ONE function (`installEventsEvidence` → `sessionsEvidence`); the ladder itself does not change.

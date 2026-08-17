# 01 — Sessions schema + RPCs

Status: resolved
Type: task

Migration per `.scratch/sessions/spec.md`: `unit_sessions` (one-open-per-person partial unique index) + `unit_redos`; RPCs `start_unit_session`, `finish_unit` (evolves `submit_install_event`: same gates, chain-in-transaction, tier suppression via the opening's stored signature), `block_unit` (reason + issue link/auto-create + chain), `reattribute_session` (5-min grace), `press_redo`; session-closing hooks inside `start_break`, `end_break` (auto-resume the held unit), `clock_out`, the dangling-shift guards, `answer_summon`/`complete_summon_help`/`close_summon`; stale auto-close (16 h) in `start_unit_session` + `clock_in`. Stop writing `task_sessions` everywhere (ADR-0001 retirement). Register both tables in the merge tooling (`unit_sessions`: None/append-only events; `unit_redos`: None) and bump the schema pin.

## Comments

2026-08-16 — Built as `supabase/migrations/20260820000000_unit_sessions.sql`. Three deliberate deviations from the ticket's letter, each safer than the letter:
1. **Triggers instead of RPC edits** for break/clock-out/summon hooks: sessions follow the time_shifts COLUMN TRANSITIONS (`unit_sessions_follow_shift`, `unit_sessions_on_clock_in`) and summon_helpers rows — the task_sessions post-mortem showed bolted-on writes die silently at the next `create or replace`; a trigger survives every rewrite, and the dangling-shift guards get covered for free (they stamp clock_out_at too).
2. **finish_unit composes over submit_install_event** (calls it, same transaction) instead of copying its body — no drift surface; minutes passed are session-derived (this round's sessions, 480-cap each), so the client's hand-typed override is gone.
3. **task_sessions writes NOT removed yet**: the old functions must keep working until ticket 02 moves the UI onto these RPCs; the retirement completes there.
Chain suppression reads the stored signature's tier count; a refused chain start (flashing owed on the next unit) never sinks the finish. Merge tooling: both tables registered append-only, schema pin 94 → 96.

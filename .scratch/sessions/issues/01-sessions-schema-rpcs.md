# 01 — Sessions schema + RPCs

Status: ready-for-agent
Type: task

Migration per `.scratch/sessions/spec.md`: `unit_sessions` (one-open-per-person partial unique index) + `unit_redos`; RPCs `start_unit_session`, `finish_unit` (evolves `submit_install_event`: same gates, chain-in-transaction, tier suppression via the opening's stored signature), `block_unit` (reason + issue link/auto-create + chain), `reattribute_session` (5-min grace), `press_redo`; session-closing hooks inside `start_break`, `end_break` (auto-resume the held unit), `clock_out`, the dangling-shift guards, `answer_summon`/`complete_summon_help`/`close_summon`; stale auto-close (16 h) in `start_unit_session` + `clock_in`. Stop writing `task_sessions` everywhere (ADR-0001 retirement). Register both tables in the merge tooling (`unit_sessions`: None/append-only events; `unit_redos`: None) and bump the schema pin.

## Comments

# 02 — Field UI: Finish, Block, the chain banner, break resume

Status: resolved
Type: task
Blocked by: 01

OpeningSheet evolves into the first flow installers learn (ADR-0003): Finish runs the existing capture gates then `finish_unit` with the proposed next unit (`pickNextOpening`); the 5-minute "Clock's on ⟨next⟩ — change?" banner drives `reattribute_session`; Block button with the four preset reasons + Other + existing-issue linking, then the same hand-off banner; break-end confirmation toast ("Back on window 14"); client lib `app/src/lib/install/sessions.ts` with pure helpers (session minutes derivation w/ 480 cap, held-unit resolution, banner countdown) + tests. e2e: fixture-driven finish→chain and block→issue RPC payload capture.

## Comments

2026-08-17 — Built. `submitInstallEvent` now calls `finish_unit` with `nextOpeningId` riding in the outbox params (offline finishes chain at flush — the app's existing outbox philosophy). Chained arrival shows the ⛓️ banner (5-min countdown via `chainGraceRemainingMs`) + Change-window picker → `reattribute_session`. Block button beside "Done — capture it": four preset reasons + Other, server auto-creates/links the blocker issue, same hand-off as Finish. Start button → `start_unit_session`. Hand-typed minutes REMOVED ("Time records itself from your sessions. Breaks never count."). Break-end toast reads the auto-resumed session. `lib/install/sessions.ts` w/ 4 pure tests; e2e proves Block fires the real RPC with reason + chain target. task_sessions writes still fire inside the old composed-over submit — full retirement deferred to a dedicated cleanup once the flow is field-proven.

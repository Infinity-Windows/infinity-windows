# 02 — Field UI: Finish, Block, the chain banner, break resume

Status: ready-for-agent
Type: task
Blocked by: 01

OpeningSheet evolves into the first flow installers learn (ADR-0003): Finish runs the existing capture gates then `finish_unit` with the proposed next unit (`pickNextOpening`); the 5-minute "Clock's on ⟨next⟩ — change?" banner drives `reattribute_session`; Block button with the four preset reasons + Other + existing-issue linking, then the same hand-off banner; break-end confirmation toast ("Back on window 14"); client lib `app/src/lib/install/sessions.ts` with pure helpers (session minutes derivation w/ 480 cap, held-unit resolution, banner countdown) + tests. e2e: fixture-driven finish→chain and block→issue RPC payload capture.

## Comments

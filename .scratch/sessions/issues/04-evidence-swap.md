# 04 — Evidence swap: cohorts feed on sessions

Status: ready-for-agent
Type: task
Blocked by: 01

New `sessionsEvidence: EvidenceSource` in `app/src/lib/estimate/cohorts.ts`: per-unit install evidence = Σ sessions (`role in install/helper`, `is_rework=false`, minutes derived w/ cap) joined to the opening's stored `sig_key`/`signature`; swap `installEventsEvidence` at the (future) display call sites — the ladder itself must not change (its tests prove it). One-time backfill: historical `summon_helpers` rows → helper evidence. Labor-minutes rollup helper (sessions + flashing phase minutes) for the unit history line. Rework rate query (units with any `unit_redos` / finished units).

## Comments

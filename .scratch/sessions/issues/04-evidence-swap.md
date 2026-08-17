# 04 — Evidence swap: cohorts feed on sessions

Status: resolved
Type: task
Blocked by: 01

New `sessionsEvidence: EvidenceSource` in `app/src/lib/estimate/cohorts.ts`: per-unit install evidence = Σ sessions (`role in install/helper`, `is_rework=false`, minutes derived w/ cap) joined to the opening's stored `sig_key`/`signature`; swap `installEventsEvidence` at the (future) display call sites — the ladder itself must not change (its tests prove it). One-time backfill: historical `summon_helpers` rows → helper evidence. Labor-minutes rollup helper (sessions + flashing phase minutes) for the unit history line. Rework rate query (units with any `unit_redos` / finished units).

## Comments

2026-08-17 — Built. `sessionsEvidence` in cohorts.ts with the pure `evidenceFromSessions` underneath: one sample per unit = Σ non-rework install+helper session minutes (480-cap each), finished rounds only (an end_reason='finish' must exist), blocked time excluded structurally. The ladder didn't change a line — its tests prove the swap contract. Backfill migration turns historical completed summon_helpers into helper sessions idempotently. `laborBreakdown` + the "Crew time: Xm install · Ym helpers · Zm flashing — Nm total" line on installed windows (rework its own line). `reworkRate` helper. Display call sites for estimates stay future work (foreman+ estimating UI), per the standing decision.

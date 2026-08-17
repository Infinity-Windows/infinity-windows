# 04 — Cohort read model + fallback ladder

Status: resolved
Type: task
Blocked by: 03

Pure lib `app/src/lib/estimate/cohorts.ts`: group evidence by `sig_key`, resolve the fallback ladder (exact → same kind + panelCount → same kind → global), n ≥ 5 per rung, always return `{ rung, n, minutes | null }`; below global n = 5 return the "no estimate yet · N installs recorded" shape and accept a labelled manual estimate. Foreman+ display only (standing decision: installers never see installer-vs-average).

Evidence source lands with the sessions effort (ADR-0001); until sessions exist, wire against `install_events.minutes` behind the same interface so the ladder ships testable now and swaps its source later.

## Comments

2026-08-16 — Built as `app/src/lib/estimate/cohorts.ts`: `estimateForSignature` resolves the ladder (exact → kind+panels → kind → global) at n ≥ 5 per rung, always returning `{rung, n, minutes (median), label}`; below global n=5 → the "no estimate yet · N installs recorded" shape; `manualEstimate` is the only number allowed below the ladder and wears "manual estimate — not from data". Versions never mix on ANY rung. Evidence behind `EvidenceSource`: `installEventsEvidence` (non-voided install_events joined to stored sig_key/signature, company-wide) — the sessions effort swaps this function, the ladder never changes. Display wiring is deliberately absent: the estimating UI arrives with the sessions effort, foreman+ only per the standing decision.

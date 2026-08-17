# 04 — Cohort read model + fallback ladder

Status: ready-for-agent
Type: task
Blocked by: 03

Pure lib `app/src/lib/estimate/cohorts.ts`: group evidence by `sig_key`, resolve the fallback ladder (exact → same kind + panelCount → same kind → global), n ≥ 5 per rung, always return `{ rung, n, minutes | null }`; below global n = 5 return the "no estimate yet · N installs recorded" shape and accept a labelled manual estimate. Foreman+ display only (standing decision: installers never see installer-vs-average).

Evidence source lands with the sessions effort (ADR-0001); until sessions exist, wire against `install_events.minutes` behind the same interface so the ladder ships testable now and swaps its source later.

## Comments

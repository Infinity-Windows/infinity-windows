# Servicing

Owner approved the Servicing plan on September 17, 2026. Build the complete feature in this isolated checkout; preserve prior service cases and all payroll/installation records. Approved behavior is recorded in `../outputs/Servicing_Plan_2026-09-17.md` (workspace path outside this checkout).

Confirmed: units may have different causes; supervisor approves shared trip cost split. Lodging chat goes to assigned job supervisor, or all supervisors with login access if unassigned.

Implementation: service_visits, service_visit_units, service_time_sessions linked to payroll shifts, private immutable service-media, retry receipts, audit records. No financial rates or Roster permission changes. New job supervisor assignment fills the previously absent job-level field. All timers share the existing per-worker lock and stop on breaks/clock-out/surface changes.

Validation before release: real PostgreSQL-compatible fixture checks, unit tests, English/Spanish phone/desktop browser checks, full tests/lint/build/bundle, CI, live read-only verification. No test writes to live business records.

Implementation complete locally; release checks in progress. No live data changed during validation.

Useful boundaries: new visits require a connection; already loaded visits retain queued notes/timers and original evidence on the device. Offline intervals received after clock-out remain flagged until a supervisor compares them with payroll. Voice recordings stop at three minutes to match the existing transcription service. Missing required evidence needs a written explanation. PDFs show billing review status; downloading does not send an invoice. Shared-cost approval stays supervisor/owner-only. Original photos that the current browser cannot render remain in the ZIP with an explicit PDF reference.

Crew reports expose only the payroll time bounds needed for that visit; installers gain no access to another worker's full timecard or pay rates. Earlier service cases remain available to their existing foreman-and-above audience.

Validation: 64 disposable database assertions; 13 browser flows across roles, phone/desktop, English/Spanish, map transfer, offline replay, PDF/CSV/ZIP and original evidence. Full application tests, build, lint and release checks recorded separately.

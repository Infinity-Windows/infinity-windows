# Installer daily reporting

As requested September 16, 2026, daily reporting is available to installers and every higher internal crew role. It is reachable from Capture → Daily log, Jobs → a job → Logs, the Log today landing chip, and the offer after clock-out. The job tab and reporting controls support English and Spanish.

The existing model remains one shared report per job per day. Crew members can read, file and edit that shared report. First author and latest editor remain recorded. Notes are required, future dates are rejected, and offline reports use the existing merge-and-sync path.

The database independently checks a recognized internal role and that access has not been revoked. On-site availability is not an access switch. Partner logins cannot read daily_logs or call file_daily_log, including partners with an installer role. Direct table writes remain blocked, the QA sandbox guard remains attached, and sharing with the builder remains supervisor-only.

Validation: phone and desktop report filing; installer Capture and clock-out entry points; Spanish; existing offline queue tests; real disposable PostgreSQL checks for crew roles, revoked/missing users, partners, validation, authorship, one-log-per-day, direct writes and customer sharing. A fixture browser test does not establish production deployment; check the release and a real installer session after merging.

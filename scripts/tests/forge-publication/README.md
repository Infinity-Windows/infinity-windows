# Connected publication execution checks

Run `scripts/test-forge-permissions.sh` from the repository. It starts its own PostgreSQL 16 container with synthetic data, no network or host ports, and removes only that container on exit.

The existing permission suite runs first. The new migration is then applied, with empty synthetic history-count tables for the otherwise unrelated account-removal RPC. Assertions execute the real publication functions and policies: explicit links, duplicate creation, isolated drafts, stale versions, immutable history, exact request retries, unrelated draft preservation, dates, conflicts, crew access revocation, attachment metadata/storage protection, late-failure rollback, cancellation, two rotations, outbox claims, lease ownership/expiry, and account-history counts. Two separate database connections publish one request concurrently; exactly one revision, event and recipient notice must remain.

These are PostgreSQL execution checks and browser fixtures, not full Supabase Storage HTTP or actual push-delivery tests. No production data or credentials are used. The existing full job-purge body is preserved and its table coverage follows the latest migration in `trashCascade.test.ts`; the disposable fixture is not a complete job-purge rehearsal.

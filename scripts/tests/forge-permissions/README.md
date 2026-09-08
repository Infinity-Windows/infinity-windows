# Forge database permission tests

Run `scripts/test-forge-permissions.sh` from any directory with Docker available. It uses `postgres:16-alpine` in a unique disposable container, no network, no host ports and a tmpfs database. Cleanup removes only the container created by this run. No production credentials or business records are loaded.

The harness replays the original Schedule and Travel migrations against minimal synthetic auth/storage/project infrastructure, adds the later delivery columns and partner policy guard, applies the new permissions migration twice, and executes reads/writes as actual PostgreSQL roles. Assertions cover installer, foreman, supervisor, owner, legacy managers, partner-with-supervisor-rank, unknown role, anonymous and service role; draft privacy; personal flights; malformed cross-trip attachment links; raw file object access; membership removal; job-level vs scheduled vehicle links; and delivery creation/rescheduling.

This verifies PostgreSQL policies and the delivery transaction. It is not a full Supabase restore or a Storage HTTP integration test. Existing signed URLs are bearer tokens until expiration (currently one hour in the app); changing RLS prevents new access/signing but cannot retract already downloaded files or promise immediate expiry of an issued URL. A deployment review must account for that limit.

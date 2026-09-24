#!/usr/bin/env bash
# Forge AI daily-log contributions under REAL concurrent sessions, in a
# disposable, network-isolated PostgreSQL 16 container (same pattern as
# scripts/test-forge-permissions.sh). Synthetic records only; no host ports,
# credentials, production data, shared containers or volumes.
# The single-session rules (roles, validation, photos) are
# scripts/verify-ai-daily-logs.mjs.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
FIXTURES="$REPO/scripts/tests/ai-daily-logs"
CONTAINER="forge-ai-daily-logs-$$-$RANDOM"
WORK=$(mktemp -d)
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
docker run --detach --name "$CONTAINER" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=disposable-fixture-password postgres:16-alpine >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then echo "Disposable PostgreSQL did not finish starting within 60 seconds." >&2; exit 1; fi

# person_record_counts names tables these stubs do not create.
run_sql() { docker exec -i -e PGOPTIONS='-c check_function_bodies=off' "$CONTAINER" psql -X -U postgres -v ON_ERROR_STOP=1 -q "${@:2}" < "$1"; }
run_sql "$FIXTURES/setup.sql"
run_sql "$REPO/supabase/migrations/20260949000000_daily_logs.sql"
run_sql "$REPO/supabase/migrations/20260951000000_share_with_builder.sql"
run_sql "$REPO/supabase/migrations/20261014000000_installer_daily_reporting.sql"
# The job boundary the AI field tools already use, taken from its migration.
awk '/^create function public._ai_job_visible/{on=1} on{print} on&&/^\$\$;/{exit}' \
  "$REPO/supabase/migrations/20261024000000_ai_field_operations.sql" > "$WORK/visible.sql"
run_sql "$WORK/visible.sql"
run_sql "$REPO/supabase/migrations/20261030000000_ai_daily_log_contributions.sql"
run_sql "$REPO/supabase/migrations/20261030000000_ai_daily_log_contributions.sql"
run_sql "$FIXTURES/seed.sql"

JOB_A=00000000-0000-4000-8000-000000000090
JOB_B=00000000-0000-4000-8000-000000000091
pids=()
# The same draft saved four times at once (double tap + retries).
for n in 1 2 3 4; do
  run_sql "$FIXTURES/race.sql" -v tag="same-$n" -v actor=00000000-0000-4000-8000-000000000001 -v claimed=00000000-0000-4000-8000-000000000001 \
    -v cid=00000000-0000-4000-8000-000000001001 -v job="$JOB_A" -v words="Set frames east wall" &
  pids+=($!)
done
# Four people, four drafts, all previewed against the same empty job-day.
for n in 1 2 3 4; do
  run_sql "$FIXTURES/race.sql" -v tag="people-$n" -v actor="00000000-0000-4000-8000-00000000000$n" -v claimed="00000000-0000-4000-8000-00000000000$n" \
    -v cid="00000000-0000-4000-8000-00000000200$n" -v job="$JOB_B" -v words="Person $n finished work" &
  pids+=($!)
done
# Ana's draft sent from a phone that is now signed in as Ben, beside the rest.
run_sql "$FIXTURES/race.sql" -v tag="wrong-actor" -v actor=00000000-0000-4000-8000-000000000003 \
  -v claimed=00000000-0000-4000-8000-000000000001 -v cid=00000000-0000-4000-8000-000000003001 -v job="$JOB_A" -v words="Ana words under Ben" &
pids+=($!)
for pid in "${pids[@]}"; do wait "$pid"; done
run_sql "$FIXTURES/assertions.sql"
printf 'AI daily log concurrency checks passed (disposable PostgreSQL 16, 9 concurrent sessions).\n'

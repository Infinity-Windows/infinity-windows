#!/usr/bin/env bash
# Genuine two-session PostgreSQL tests. Synthetic records, isolated container,
# no host ports/production credentials, no shared volumes, guaranteed cleanup.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
FIX="$REPO/scripts/tests/stage-contributors"
CONTAINER="stage-contributors-$$-$RANDOM"
LOG=$(mktemp -d)
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$LOG"; }
trap cleanup EXIT
docker run --detach --name "$CONTAINER" --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=disposable-fixture-password postgres:16-alpine >/dev/null
ready=false
for attempt in $(seq 1 60); do
 if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
 sleep 1
done
[ "$ready" = true ] || { echo 'Disposable PostgreSQL did not start'; exit 1; }
sql() { docker exec -i "$CONTAINER" psql -X -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
# Defer unrelated platform-helper bodies absent from this bounded fixture,
# as in the existing AI harness. Contributor RPCs are exercised below.
run() { sql -c 'set check_function_bodies=off' -f - < "$1"; }
query() { docker exec "$CONTAINER" psql -X -U postgres -v ON_ERROR_STOP=1 -Atq -c "$1"; }
run "$FIX/setup.sql"
for migration in 20261011000000_custom_work.sql 20261023000000_foreman_crew_unit_records.sql 20261024000000_ai_field_operations.sql 20261049000000_foreman_unit_contributors.sql; do run "$REPO/supabase/migrations/$migration"; done
run "$FIX/seed.sql"
# Prove actual contention rather than mistaking two sequential calls for it.
wait_for_lock() {
 for attempt in $(seq 1 30); do
  if [ "$(query "select count(*) from pg_locks where locktype='advisory' and not granted")" -gt 0 ]; then echo 'Observed simultaneous transactions contending on an advisory lock'; return; fi
  sleep 0.05
 done
 echo 'No overlapping transactions observed'; return 1
}
wait_for_first_transaction() {
 for attempt in $(seq 1 40); do
  if [ "$(query "select count(*) from pg_stat_activity where wait_event='PgSleep'")" -gt 0 ]; then return; fi
  sleep 0.05
 done
 echo 'First transaction did not reach its held-lock barrier'; return 1
}
run "$FIX/concurrent-add-a.sql" >"$LOG/add-a" 2>&1 & first=$!
wait_for_first_transaction
run "$FIX/concurrent-add-b.sql" >"$LOG/add-b" 2>&1 & second=$!
wait_for_lock
if ! wait "$first"; then cat "$LOG/add-a"; exit 1; fi
if ! wait "$second"; then cat "$LOG/add-b"; exit 1; fi
[ "$(query "select count(*) from crew_work_record_people")" = 3 ] || { echo 'Concurrent overlapping additions were not deduplicated'; exit 1; }
unit=$(query "select id from custom_work_units where opening_id='00000000-0000-4000-8000-000000000020'")
digest=$(query "select public._stage_contributor_digest('$unit','Flashing',current_date-1)")
sql -v unit="$unit" -v digest="$digest" < "$FIX/concurrent-correct-a.sql" >"$LOG/correct-a" 2>&1 & first=$!
wait_for_first_transaction
sql -v unit="$unit" -v digest="$digest" < "$FIX/concurrent-correct-b.sql" >"$LOG/correct-b" 2>&1 & second=$!
wait_for_lock
if ! wait "$first"; then cat "$LOG/correct-a"; exit 1; fi
if wait "$second"; then echo 'A stale concurrent correction was accepted'; exit 1; fi
if ! grep -q 'changed since you loaded' "$LOG/correct-b"; then cat "$LOG/correct-b"; exit 1; fi
run "$FIX/assertions.sql"
echo 'Stage-contributor concurrency checks passed (disposable PostgreSQL16, two sessions).'

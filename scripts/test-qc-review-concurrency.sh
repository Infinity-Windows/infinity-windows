#!/usr/bin/env bash
# Native PostgreSQL16 lock proof. Synthetic fixture, isolated container,
# no host ports/shared volumes/live credentials. Requires existing Docker.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
FIX="$REPO/scripts/tests/qc-review-flow"
CONTAINER="qc-review-race-$$-$RANDOM"
WORK=$(mktemp -d)
cleanup() {
  local result=$?
  if [ "$result" -ne 0 ]; then
    for log in "$WORK"/*.log; do [ ! -f "$log" ] || cat "$log" >&2; done
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
docker run --detach --name "$CONTAINER" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=disposable-fixture-password postgres:16-alpine >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || { echo 'Disposable PostgreSQL did not start within 60 seconds.' >&2; exit 1; }
sql() { docker exec -i "$CONTAINER" psql -X -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
query() { docker exec "$CONTAINER" psql -X -U postgres -v ON_ERROR_STOP=1 -Atq -c "$1"; }
run() { sql < "$1"; }
run "$FIX/setup.sql"
run "$FIX/seed.sql"
# Load the exact production points and visibility functions, then both complete
# QC migrations. Only unrelated platform substrate is synthetic.
awk '/^create or replace function public.resolve_install_points\(/{on=1} on{print} on&&/^\$\$;/{exit}' \
  "$REPO/supabase/migrations/20260991000000_points_cap.sql" > "$WORK/points.sql"
awk '/^create function public._ai_job_visible\(/{on=1} on{print} on&&/^\$\$;/{exit}' \
  "$REPO/supabase/migrations/20261024000000_ai_field_operations.sql" > "$WORK/visible.sql"
run "$WORK/points.sql"
run "$WORK/visible.sql"
query 'revoke all on function public._ai_job_visible(uuid,uuid) from public,anon,authenticated' >/dev/null
run "$REPO/supabase/migrations/20261041000000_qc_decision_authority.sql"
run "$REPO/supabase/migrations/20261053000000_qc_review_flow.sql"
run "$FIX/race-setup.sql"

wait_ready() {
  for attempt in $(seq 1 100); do
    if docker exec "$CONTAINER" test -f /tmp/qc-race-ready; then return; fi
    sleep 0.05
  done
  echo 'First session did not reach its transaction barrier.' >&2; return 1
}
wait_blocked() {
  local waiter="$1" blocker="$2" alternate="${3:-$2}"
  for attempt in $(seq 1 100); do
    if [ "$(query "select count(*) from pg_stat_activity w join pg_stat_activity b on b.pid=any(pg_blocking_pids(w.pid)) where w.application_name='$waiter' and b.application_name in ('$blocker','$alternate') and w.wait_event_type='Lock'")" -gt 0 ]; then
      echo "Observed $waiter blocked by $blocker on a database lock."
      return
    fi
    sleep 0.05
  done
  echo "No actual contention observed for $waiter." >&2; return 1
}
session() {
  local name="$1" scenario="$2" request="$3" hold="$4" stale="$5" insert="$6" update="$7" actor="$8"
  sql -v session="$name" -v scenario="$scenario" -v request="$request" -v hold="$hold" \
    -v stale="$stale" -v legacy_insert="$insert" -v legacy_update="$update" -v actor="$actor" \
    < "$FIX/race-session.sql"
}
finish() { if ! wait "$1"; then cat "$2" >&2; return 1; fi; }
FOREMAN=00000000-0000-4000-8000-000000000002
SUPERVISOR=00000000-0000-4000-8000-000000000003
for scenario in legacy-insert legacy-update same-request guarded; do
  docker exec "$CONTAINER" rm -f /tmp/qc-race-ready /tmp/qc-race-release
  insert=false; update=false; stale=true; second_actor="$FOREMAN"
  case "$scenario" in
    legacy-insert) insert=true; request=00000000-0000-4000-8000-000000000901; loser=00000000-0000-4000-8000-000000000911 ;;
    legacy-update) update=true; request=00000000-0000-4000-8000-000000000902; loser=00000000-0000-4000-8000-000000000912 ;;
    same-request) stale=false; request=00000000-0000-4000-8000-000000000903; loser="$request" ;;
    guarded) request=00000000-0000-4000-8000-000000000904; loser=00000000-0000-4000-8000-000000000914; second_actor="$SUPERVISOR" ;;
  esac
  session "qc-$scenario-a" "$scenario" "$request" true false "$insert" "$update" "$FOREMAN" > "$WORK/$scenario-a.log" 2>&1 & first=$!
  wait_ready
  session "qc-$scenario-b" "$scenario" "$loser" false "$stale" false false "$second_actor" > "$WORK/$scenario-b.log" 2>&1 & second=$!
  wait_blocked "qc-$scenario-b" "qc-$scenario-a"
  if [ "$scenario" = legacy-update ]; then
    # B is waiting on A's QC row after locking the opening. This must remain
    # compatible with the KEY SHARE needed by A's imminent history FK insert.
    query "select o.id from project_openings o join qc_race_cases c on c.opening=o.id where c.name='legacy-update' for key share of o nowait" >/dev/null
    echo 'Opening FK KEY SHARE remains available while guarded writer waits on legacy QC row.'
  fi
  if [ "$scenario" = same-request ]; then
    session "qc-$scenario-c" "$scenario" "$request" false false false false "$FOREMAN" > "$WORK/$scenario-c.log" 2>&1 & third=$!
    wait_blocked "qc-$scenario-c" "qc-$scenario-a" "qc-$scenario-b"
  fi
  docker exec "$CONTAINER" touch /tmp/qc-race-release
  finish "$first" "$WORK/$scenario-a.log"
  finish "$second" "$WORK/$scenario-b.log"
  if [ "$scenario" = same-request ]; then finish "$third" "$WORK/$scenario-c.log"; fi
done
run "$FIX/race-assertions.sql"
echo 'QC review concurrency passed (PostgreSQL16; four observed races, nine sessions; no stale event/point residue).'

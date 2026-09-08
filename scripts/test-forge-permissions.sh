#!/usr/bin/env bash
# Real PostgreSQL RLS checks in a disposable, network-isolated local container.
# No host ports, credentials, production data, shared containers or volumes.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
FIXTURES="$REPO/scripts/tests/forge-permissions"
CONTAINER="forge-permissions-$$-$RANDOM"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# The image is also used in CI; a local cached copy works without network.
docker run --detach --name "$CONTAINER" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=disposable-fixture-password postgres:16-alpine >/dev/null
for attempt in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
run_sql() { docker exec -i "$CONTAINER" psql -X -U postgres -v ON_ERROR_STOP=1 -q < "$1"; }
run_sql "$FIXTURES/setup.sql"
run_sql "$REPO/supabase/migrations/20260721010000_crew_scheduling.sql"
run_sql "$REPO/supabase/migrations/20260723020000_travel_info.sql"
run_sql "$FIXTURES/baseline.sql"
run_sql "$REPO/supabase/migrations/20261003000000_forge_workflow_permissions.sql"
# The deploy path can be retried. Applying twice must retain the same boundary.
run_sql "$REPO/supabase/migrations/20261003000000_forge_workflow_permissions.sql"
run_sql "$FIXTURES/assertions.sql"
printf 'Forge database permission checks passed (disposable PostgreSQL 16).\n'

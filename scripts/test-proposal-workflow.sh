#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOX="proposal-workflow-$$-$RANDOM"
trap 'docker rm -f "$BOX" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$BOX" --network none --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=disposable-fixture postgres:16-alpine >/dev/null
for n in $(seq 1 60); do if docker exec "$BOX" pg_isready -U postgres >/dev/null 2>&1;then break;fi;sleep 1;done
run(){ docker exec -i "$BOX" psql -X -U postgres -v ON_ERROR_STOP=1 -q < "$1"; }
run "$ROOT/scripts/tests/forge-permissions/setup.sql"
run "$ROOT/supabase/migrations/20261007000000_proposal_workflow.sql"
run "$ROOT/scripts/tests/proposal-workflow/assertions.sql"
run "$ROOT/scripts/tests/proposal-workflow/partner-setup.sql"
run "$ROOT/supabase/migrations/20261008000000_proposal_partner_sharing.sql"
run "$ROOT/scripts/tests/proposal-workflow/partner-assertions.sql"
echo 'Proposal Workflow PostgreSQL checks passed.'

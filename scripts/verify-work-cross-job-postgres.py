#!/usr/bin/env python3
"""First genuine PG17 kernel checkpoint: exact catalog, install, roles, inert gates.

Requires the existing genuine 0841–46 fixtures in the exact disposable localhost
database. No activation or capture behavior: this first stage must establish
catalog portability before source-dependent v2 scenarios are assigned.
--check-plan is static validation only. No provider access or operational writes.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parent.parent
CANDIDATE = ROOT / "supabase/migrations/20261108470000_work_cross_job_capture.sql"
SOURCE = CANDIDATE.read_text()
SOURCE_SHA = hashlib.sha256(CANDIDATE.read_bytes()).hexdigest()
assert SOURCE_SHA == "c0eaccc11ca212853a3950bb64d47805990a2b4af824755a04d92b3fdf170c07"
assert re.search(r"rollback;\s*$", SOURCE, re.I)
assert sys.argv[1:] in ([], ["--check-plan"])
CATALOG_SQL = (ROOT / "scripts/work-cross-job-catalog.sql").read_text().strip().removesuffix(";")
PREFLIGHT = SOURCE[:SOURCE.index("-- CROSS_JOB_DDL_BEGIN")]
PREFLIGHT_INSIDE_TRANSACTION, begin_count = re.subn(r"(?im)^begin;\s*", "", PREFLIGHT, count=1)
assert begin_count == 1
assert not re.search(r"create\s+(?:or replace\s+)?(?:function|table|index|trigger)|alter\s+table|revoke\s|grant\s", PREFLIGHT, re.I)
DEPENDENCIES = {
    "supabase/migrations/20261108450000_work_activity_totals.sql": "e0e74c2d1985d332af81f95d20d2a6625c40cb5fcf995b4aa6e267d75e092140",
    "supabase/migrations/20261108460000_work_unit_contributors.sql": "ae6185e4b390b7cff8f3d7aca837688fda2756792bdf055ef8c3a1f290d438c5",
    "scripts/work-cross-job-contract.json": "413cc4f8b7d208725d636645e7683bdf39933e7e5a7d850c5479a4a7afd533e7",
    "scripts/work-cross-job-catalog.sql": "6822b8642484030e1853e8a629749ec07515c02e5eafc1739c47cdfed9328435",
    "scripts/work-cross-job-profile.json": "1136e2abd04020a0446a94c1a3077217972eefad03048bd97cb03dacfd47bfe2",
}
for name, expected in DEPENDENCIES.items():
    assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected, name
CONTRACT = json.loads((ROOT / "scripts/work-cross-job-contract.json").read_text())
assert CONTRACT["key"] == "cross_job_kernel_2"
PROFILE = json.loads((ROOT / "scripts/work-cross-job-profile.json").read_text())
assert PROFILE["expectedOldCatalogSha256"] == "18f1f9048e57087987020441e0aff395c5094ec8f677643078f551aa4d705950"
assert CONTRACT["expectedCatalogSha256"] == "00db48aa715a066d2c3cd0ec73423a8af14e7338fa2c13e36ab2ff68b49f307e"
assert "select false" in SOURCE and "create function public._work_cross_job_enabled()" in SOURCE
if sys.argv[1:] == ["--check-plan"]:
    print(json.dumps({"result": "PLAN VALIDATED", "databaseTests": False,
        "sourceSha256": SOURCE_SHA, "predecessor": "verify-work-unit-contributors-postgres.py",
        "scope": "Genuine exact catalog portability and inert installation/roles only",
        "activation": False, "v2BehaviorProof": False,
        "remaining": ["v2 actual roles/paid row scenarios", "two-session races", "volume and paidwriter wait", "provider", "browser/device"]}))
    sys.exit()

target = urlparse(os.environ.get("WORK_ACTIVITY_ROLE_TEST_DB_URL", ""))
if (target.scheme not in ("postgres", "postgresql") or target.hostname not in ("localhost", "127.0.0.1")
        or target.port not in (None, 5432) or target.path != "/forge_work_activity_role_test"
        or target.username != "supabase_admin" or target.password != "fixture-only"
        or target.query or target.fragment):
    raise SystemExit("Refused: exact disposable localhost role fixture required")
env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
env["PGCONNECT_TIMEOUT"] = "3"
report_path = os.environ.get("WORK_CROSS_JOB_POSTGRES_OUT")
report = {"status": "running", "stage": "initial", "checks": 0,
    "scope": "Actual PG17 disposable localhost roles; exact kernel catalog/inert gates only",
    "sourceSha256": SOURCE_SHA, "harnessSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "timeoutsSeconds": {"statement": 20, "lock": 12}, "activation": False,
    "v2BehaviorProof": False, "genuineConcurrency": False, "providerOperations": False,
    "freshSessionTimezoneAndFloatDefaultsProof": False}

def persist(stage=None):
    if stage:
        report["stage"] = stage
    if report_path:
        file = Path(report_path)
        temporary = file.with_name(file.name + ".tmp")
        temporary.write_text(json.dumps(report, indent=2) + "\n")
        temporary.replace(file)

def failure(kind, error, traceback):
    report.update(status="failed", failure={"type": kind.__name__, "message": str(error)[-2200:]})
    persist()
    sys.__excepthook__(kind, error, traceback)

sys.excepthook = failure
persist()

def uri(user):
    assert user in ("postgres", "authenticator")
    return urlunparse((target.scheme, f"{user}:fixture-only@{target.hostname}:{target.port or 5432}", target.path, "", "", ""))

def run(sql, user="postgres", expected_error=None, expected_message=None):
    result = subprocess.run(["psql", uri(user), "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
        input="\\set VERBOSITY verbose\nset search_path=public,pg_temp;set statement_timeout='20s';set lock_timeout='12s';" + sql,
        text=True, capture_output=True, timeout=35, env=env)
    if expected_error:
        assert result.returncode and re.search(r"\b" + expected_error + r"\b", result.stderr), result.stderr[-2200:]
        if expected_message:
            assert expected_message in result.stderr, result.stderr[-2200:]
        return None
    assert result.returncode == 0, result.stderr[-2200:]
    return result.stdout.strip()

def check(condition, label):
    assert condition, label
    report["checks"] += 1
    persist()
    print("PASS", report["checks"], label, flush=True)

check(run("select current_setting('server_version_num')::int/10000") == "17", "Actual PostgreSQL17")
check(run("select session_user='postgres' and not (select rolsuper from pg_roles where rolname=session_user)") == "t", "Actual nonsuperuser source-owner session")
check(run("select session_user='authenticator' and not (select rolsuper or rolinherit from pg_roles where rolname=session_user)", "authenticator") == "t", "Actual noninheriting authenticator session")
check(run("select _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()") == "t", "Frozen genuine predecessor coverage")
persist("old_catalog_portability")
old_catalog = json.loads(run(CATALOG_SQL).splitlines()[-1])
report["oldCatalog"] = old_catalog
report["oldCatalogSha256"] = run("select encode(sha256(convert_to(c.value::text,'UTF8')),'hex') from (" + CATALOG_SQL + ") c")
persist()
check(report["oldCatalogSha256"] == "18f1f9048e57087987020441e0aff395c5094ec8f677643078f551aa4d705950", "Unmodified exact kernel preflight catalog matches genuine fixture")
run(PREFLIGHT + "rollback;")
check(True, "Metadata-only preflight passes before DDL")
for mutation in [
    "create table work_cross_job_unknown(id int)",
    "create function work_cross_job_command(text) returns int language sql as 'select 1'",
    "grant execute on function _work_activity_resume(personal_activity_state,time_shifts,timestamptz) to authenticated",
    "grant select(profile_id) on personal_activity_state to public",
    "alter table time_shifts disable trigger service_shift",
    "create type work_cross_job_unknown as enum('unknown')",
    "create type cross_job_unknown_type as enum('unknown')",
    "create sequence cross_job_unknown_sequence",
]:
    # Each actual mutation rolls back when the strict preflight raises.
    run("begin;" + mutation + ";" + PREFLIGHT_INSIDE_TRANSACTION, expected_error="55000")
    check(True, "Genuine source preflight refuses: " + mutation)
persist("candidate_install")
run(re.sub(r"rollback;\s*$", "commit;", SOURCE, flags=re.I))
check(run("select _work_cross_job_coverage() and _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()") == "t", "Exact promoted guards pass genuine inactive kernel")
new_catalog = json.loads(run(CATALOG_SQL).splitlines()[-1])
report["newCatalog"] = new_catalog
report["newCatalogSha256"] = run("select encode(sha256(convert_to(c.value::text,'UTF8')),'hex') from (" + CATALOG_SQL + ") c")
persist()
check(report["newCatalogSha256"] == CONTRACT["expectedCatalogSha256"], "Unmodified exact promoted catalog matches reviewed assembly constant")
check(run("select not _work_cross_job_enabled()") == "t", "Installed kernel admission remains false")
for mutation in (
    "update work_cross_job_contract set expected_catalog_sha256=repeat('0',64)",
    "delete from work_cross_job_contract",
    "insert into work_cross_job_contract values('cross_job_kernel_2',repeat('0',64))",
    "truncate work_cross_job_contract",
):
    run("begin;" + mutation + ";rollback;", expected_error="23514")
    check(True, "Actual nonsuper source-owner cannot mutate expected proof: " + mutation.split()[0])
check(run("select _work_cross_job_coverage() and _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()") == "t", "Proof refusal leaves all four actual guards admitted")
# Own coverage deliberately becomes true here. The three independent boundary
# pins must refuse; the held v2 activation switch cannot mask this test.
run_true = "create or replace function _work_cross_job_coverage() returns boolean language sql stable security definer set search_path=public,pg_temp as $$select true$$"
check(run("begin;" + run_true + ";select _work_cross_job_coverage() and not _work_unit_review_coverage() and not _work_totals_coverage() and not _work_unit_contributors_coverage();rollback;") == "t", "Replacing attester with select true refuses all three previously admitted report boundaries")
for role in ("anon", "service_role"):
    run("set role " + role + ";select work_cross_job_snapshot('00000000-0000-4000-8000-000000470001'::uuid);", "authenticator", "42501", expected_message="permission denied for function work_cross_job_snapshot")
    check(True, "Actual " + role + " denied new snapshot entry")
run("set role authenticated;select _work_cross_job_enabled();", "authenticator", "42501", expected_message="permission denied for function _work_cross_job_enabled")
check(True, "Authenticated caller cannot invoke private activation gate")
for role in ("anon", "authenticated", "service_role"):
    run("set role " + role + ";select * from work_cross_job_contract;", "authenticator", "42501", expected_message="permission denied for table work_cross_job_contract")
    check(True, "Actual " + role + " cannot read private expected proof")
    run("set role " + role + ";select _work_cross_job_coverage();", "authenticator", "42501", expected_message="permission denied for function _work_cross_job_coverage")
    check(True, "Actual " + role + " cannot call private attester")
    run("set role " + role + ";select _work_cross_job_clock_receipt_fingerprint((select null::work_activity_clock_receipts));", "authenticator", "42501", expected_message="permission denied for function _work_cross_job_clock_receipt_fingerprint")
    check(True, "Actual " + role + " cannot call private canonical fingerprint")
body = run("select prosrc from pg_proc where oid='_work_cross_job_table(text)'::regprocedure")
definition = run("select pg_get_functiondef('_work_cross_job_table(text)'::regprocedure)")
assert definition.count(body) == 1
body_drift = definition.replace(body, body + "\n-- Unreviewed dependency source drift\n", 1)
for mutation in [
    "grant execute on function _work_cross_job_resume_basis(personal_activity_state,time_shifts,timestamptz) to authenticated",
    "grant select(profile_id) on work_cross_job_resume to authenticated",
    "create index cross_job_unknown_idx on work_cross_job_bindings(profile_id)",
    "grant select(expected_catalog_sha256) on work_cross_job_contract to authenticated",
    "alter function _work_cross_job_coverage() cost 101",
    "alter function _work_cross_job_table(text) cost 101",
    "alter function _work_cross_job_clock_receipt_fingerprint(work_activity_clock_receipts) cost 101",
    "grant execute on function _work_cross_job_clock_receipt_fingerprint(work_activity_clock_receipts) to authenticated",
    body_drift,
    "create type cross_job_post_unknown_type as enum('unknown')",
    "create sequence cross_job_post_unknown_sequence",
]:
    check(run("begin;" + mutation + ";select not _work_cross_job_coverage() and not _work_unit_review_coverage() and not _work_totals_coverage() and not _work_unit_contributors_coverage();rollback;") == "t", "Genuine post-install drift fences kernel and old report: " + mutation)
check(run("select _work_cross_job_coverage() and _work_unit_review_coverage() and _work_totals_coverage() and _work_unit_contributors_coverage()") == "t", "Rollback restores all four exact inactive guards")
report["status"] = "passed"
persist("complete_inert_catalog_roles")
print(json.dumps({key: value for key, value in report.items() if key not in ("oldCatalog", "newCatalog")}), flush=True)

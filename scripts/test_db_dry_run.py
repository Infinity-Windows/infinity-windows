#!/usr/bin/env python3
"""Tests for scripts/db_dry_run.py — the batch builder and the judge.

What is pinned here is the promise the wrapper makes: nothing that could
escape the transaction gets into the batch, a migration's own begin/commit
wrapper is set aside rather than trusted, and the answer is read correctly in
every shape it can arrive in — the Management API's JSON, a wrapped JSON, or
psql's plain stderr. Offline: no token, no project, no network.

    python3 scripts/test_db_dry_run.py
"""
import json
import os
import sys
import tempfile
import unittest
from io import StringIO
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db_dry_run as d  # noqa: E402


def write(directory, name, text):
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


PROBE = "select pg_temp.dry_run_check('a', true, null);\n"


class SplitStatements(unittest.TestCase):
    def skeletons(self, sql):
        return [s.skeleton for s in d.split_statements(sql)]

    def test_plain_statements(self):
        self.assertEqual(self.skeletons("select 1; select 2;"), ["select 1", "select 2"])

    def test_comments_and_blank_runs_are_not_statements(self):
        sql = "-- commit;\n/* commit; */\nselect 1;\n\n-- trailing\n"
        self.assertEqual(self.skeletons(sql), ["select 1"])

    def test_nested_block_comment(self):
        self.assertEqual(self.skeletons("/* a /* commit; */ b */ select 1;"), ["select 1"])

    def test_semicolons_in_strings_and_identifiers(self):
        sql = "select 'a;b'; select \"c;d\" from t; insert into t values (E'it\\'s; commit;');"
        self.assertEqual(len(self.skeletons(sql)), 3)

    def test_dollar_quoted_bodies_hide_their_end(self):
        sql = "create function f() returns void language plpgsql as $$ begin perform 1; end; $$;\nselect 1;"
        self.assertEqual(self.skeletons(sql), ["create function f() returns void language plpgsql as $body$", "select 1"])

    def test_tagged_dollar_quotes(self):
        sql = "do $x$ begin commit; end $x$; select 1;"
        self.assertEqual(self.skeletons(sql), ["do $body$", "select 1"])

    def test_positional_parameters_are_not_dollar_quotes(self):
        sql = "select $1; select 2;"
        self.assertEqual(self.skeletons(sql), ["select $1", "select 2"])

    def test_code_start_skips_leading_comments(self):
        sql = "-- header\n-- more\nbegin;\nselect 1;"
        first = d.split_statements(sql)[0]
        self.assertEqual(sql[first.code_start:first.end], "begin;")
        self.assertEqual(first.start, 0)


class Hostile(unittest.TestCase):
    def refused(self, sql):
        with self.assertRaises(d.Refused) as ctx:
            d.prepare_migration("m.sql", sql)
        return str(ctx.exception)

    def test_create_index_concurrently(self):
        self.assertIn("CONCURRENTLY", self.refused("create index concurrently i on t (a);"))
        self.assertIn("CONCURRENTLY", self.refused("create unique index concurrently i on t (a);"))

    def test_drop_index_and_reindex_concurrently(self):
        self.assertIn("DROP INDEX CONCURRENTLY", self.refused("drop index concurrently i;"))
        self.assertIn("REINDEX", self.refused("reindex table concurrently t;"))

    def test_vacuum_alter_system_database(self):
        self.assertIn("VACUUM", self.refused("select 1; vacuum t;"))
        self.assertIn("ALTER SYSTEM", self.refused("alter system set work_mem = '1MB';"))
        self.assertIn("database", self.refused("create database x;"))

    def test_commit_in_the_middle(self):
        self.assertIn("commit", self.refused("create table t (a int);\ncommit;\ncreate table u (a int);"))

    def test_end_as_commit_synonym_in_the_middle(self):
        self.assertIn("commit", self.refused("create table t (a int);\nend;\ncreate table u (a int);"))

    def test_rollback_and_savepoint_rollback(self):
        self.assertIn("rolls back", self.refused("select 1; rollback;"))
        self.assertIn("rolls back", self.refused("select 1; rollback to savepoint s;"))

    def test_set_transaction(self):
        self.assertIn("transaction properties", self.refused("set transaction read only; select 1;"))

    def test_psql_meta_command_and_copy(self):
        self.assertIn("psql", self.refused("\\echo hi\nselect 1;"))
        self.assertIn("COPY", self.refused("copy t from stdin;"))

    def test_half_a_wrapper_is_refused(self):
        self.assertIn("starts a transaction", self.refused("begin;\ncreate table t (a int);"))
        self.assertIn("commit", self.refused("create table t (a int);\ncommit;"))

    def test_a_begin_after_the_first_statement_is_refused(self):
        self.assertIn("starts a transaction", self.refused("create table t (a int);\nbegin;\nselect 1;\ncommit;"))

    def test_words_inside_bodies_comments_and_strings_are_fine(self):
        sql = ("-- commit; here is fine\n"
               "create function f() returns void language plpgsql as $$ begin perform 1; end; $$;\n"
               "select 'vacuum;', \"commit\";\n"
               "insert into t values (E'don\\'t commit;');\n")
        text, notes = d.prepare_migration("m.sql", sql)
        self.assertEqual(text, sql)
        self.assertEqual(notes, [])

    def test_empty_file_is_refused(self):
        self.assertIn("no SQL", self.refused("-- nothing\n"))


class Wrapper(unittest.TestCase):
    def test_whole_file_wrapper_is_set_aside_and_comments_kept(self):
        sql = ("-- The header explains why.\n"
               "begin;\n"
               "create table t (a int);\n"
               "-- between\n"
               "select 1;\n"
               "commit;\n")
        text, notes = d.prepare_migration("m.sql", sql)
        self.assertEqual(len(notes), 1)
        self.assertIn("set aside", notes[0])
        self.assertIn("-- The header explains why.", text)
        self.assertIn("-- between", text)
        self.assertIn("create table t (a int);", text)
        skeletons = [s.skeleton for s in d.split_statements(text)]
        self.assertNotIn("begin", skeletons)
        self.assertNotIn("commit", skeletons)
        self.assertEqual(skeletons, ["create table t (a int)", "select 1"])

    def test_wrapper_variants(self):
        for begin, end in [("begin;", "commit;"), ("BEGIN WORK;", "COMMIT WORK;"),
                           ("start transaction;", "end;"), ("begin transaction;", "commit transaction;")]:
            text, notes = d.prepare_migration("m.sql", f"{begin}\nselect 1;\n{end}\n")
            self.assertEqual(len(notes), 1, (begin, end))
            self.assertEqual([s.skeleton for s in d.split_statements(text)], ["select 1"], (begin, end))

    def test_a_wrapper_with_a_commit_inside_is_still_refused(self):
        with self.assertRaises(d.Refused):
            d.prepare_migration("m.sql", "begin;\nselect 1;\ncommit;\nselect 2;\ncommit;\n")


class Probe(unittest.TestCase):
    def test_a_probe_may_not_carry_transaction_control(self):
        for sql in ["begin;\n" + PROBE + "commit;\n", PROBE + "commit;\n", PROBE + "rollback;\n", "savepoint s;\n" + PROBE + "rollback to s;\n"]:
            with self.assertRaises(d.Refused) as ctx:
                d.check_probe("p.sql", sql)
            self.assertIn("A probe never", str(ctx.exception))

    def test_a_probe_that_checks_nothing_is_refused(self):
        with self.assertRaises(d.Refused) as ctx:
            d.check_probe("p.sql", "select 1;\n")
        self.assertIn("dry_run_check", str(ctx.exception))

    def test_expect_error_alone_counts_as_checking(self):
        self.assertEqual(d.check_probe("p.sql", "select pg_temp.dry_run_expect_error('x', 'select 1/0');\n"), 1)


class Build(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.out = os.path.join(self.dir, "batch.sql")
        self.probe = write(self.dir, "probe.sql", PROBE)

    def batch(self):
        with open(self.out, encoding="utf-8") as fh:
            return fh.read()

    def test_shape_of_the_batch(self):
        m1 = write(self.dir, "1.sql", "create table t1 (a int);\n")
        m2 = write(self.dir, "2.sql", "begin;\ncreate table t2 (a int);\ncommit;\n")
        plan = d.build(self.out, self.probe, [m1, m2])
        batch = self.batch()
        self.assertTrue(batch.startswith("begin;\n"))
        self.assertIn("set local lock_timeout = '5s';", batch)
        self.assertIn("set local statement_timeout = '120s';", batch)
        # Order: harness, migration 1, migration 2, probe, the forced error.
        positions = [batch.index(x) for x in ("create temp table dry_run_results", "create table t1", "create table t2", PROBE.strip(), "raise exception 'DRY_RUN_RESULT:%:DRY_RUN_END'")]
        self.assertEqual(positions, sorted(positions))
        self.assertTrue(batch.rstrip().endswith("end $dry$;"))
        # Exactly one transaction start, and no commit at the top level.
        skeletons = [s.skeleton for s in d.split_statements(batch)]
        self.assertEqual(skeletons.count("begin"), 1)
        self.assertEqual([s for s in skeletons if s.startswith(("commit", "end"))], [])
        self.assertIn("set aside", plan[1])
        self.assertTrue(plan[-1].startswith("batch: "))

    def test_every_helper_is_granted_to_the_client_roles(self):
        # The project's default privileges revoke EXECUTE from public, so a
        # helper without its grant would fail the moment a probe acts as a
        # signed-in person.
        m = write(self.dir, "1.sql", "select 1;\n")
        d.build(self.out, self.probe, [m])
        batch = self.batch()
        for fn in ("dry_run_check(text, boolean, text)", "dry_run_act_as(uuid)", "dry_run_as_system()",
                   "dry_run_pick(text)", "dry_run_pick_real(text)", "dry_run_job(text)",
                   "dry_run_sandbox_job()", "dry_run_expect_error(text, text, text)"):
            self.assertIn(f"create function pg_temp.{fn.split('(')[0]}(", batch)
            self.assertIn(f"grant execute on function pg_temp.{fn} to anon, authenticated;", batch)
        self.assertIn("grant insert, select on table pg_temp.dry_run_results to anon, authenticated;", batch)

    def test_the_installer_and_foreman_picks_stop_rather_than_act_as_a_real_person(self):
        # 2026-09-23/24: qa.installer had been set to foreman, the picker handed
        # back a real installer, and three runs died on the testing-job fence
        # with a sentence that read like the change was broken. The behaviour
        # is proved on a real Postgres by scripts/db-dry-run-harness.test.sh;
        # this pins the words the person fixing it reads.
        m = write(self.dir, "1.sql", "select 1;\n")
        d.build(self.out, self.probe, [m])
        batch = self.batch()
        self.assertIn('dry run: no QA login has the installer role — set qa.installer ("TEST — automation, do not assign") '
                      "to Installer in the app; use dry_run_pick_real(''installer'') if the probe means a real person.", batch)
        self.assertIn('dry run: no QA login has the foreman role — set qa.foreman ("TEST — automation FOREMAN, do not assign") '
                      "to Foreman in the app; use dry_run_pick_real(''foreman'') if the probe means a real person.", batch)

    def test_the_sandbox_job_is_read_at_run_time_not_pinned(self):
        # On 2026-09-24 BLACK22 was found unflagged and probes pinned to it died
        # on the fence. The job a probe writes on is whichever is live, flagged
        # and on the sandbox list, PECAN14 first; no helper defaults to a code.
        m = write(self.dir, "1.sql", "select 1;\n")
        d.build(self.out, self.probe, [m])
        batch = self.batch()
        self.assertIn("where p.deleted_at is null and coalesce(p.is_test, false)", batch)
        self.assertIn("order by (p.job_code = 'PECAN14') desc, (p.job_code = 'BLACK22') desc, p.job_code", batch)
        self.assertIn("dry run: no job is both flagged as testing and on the sandbox list", batch)
        self.assertIn("create function pg_temp.dry_run_job(p_job_code text)\n", batch)

    def test_a_hostile_migration_writes_nothing(self):
        m = write(self.dir, "1.sql", "vacuum t;\n")
        with self.assertRaises(d.Refused):
            d.build(self.out, self.probe, [m])
        self.assertFalse(os.path.exists(self.out))

    def test_no_migrations_is_refused(self):
        with self.assertRaises(d.Refused):
            d.build(self.out, self.probe, [])

    def test_missing_file_is_refused(self):
        with self.assertRaises(d.Refused):
            d.build(self.out, self.probe, [os.path.join(self.dir, "nope.sql")])

    def test_timeouts_come_from_the_environment_and_are_checked(self):
        m = write(self.dir, "1.sql", "select 1;\n")
        os.environ["DB_DRY_RUN_LOCK_TIMEOUT"] = "500ms"
        os.environ["DB_DRY_RUN_STATEMENT_TIMEOUT"] = "3min"
        try:
            d.build(self.out, self.probe, [m])
            self.assertIn("set local lock_timeout = '500ms';", self.batch())
            self.assertIn("set local statement_timeout = '3min';", self.batch())
            os.environ["DB_DRY_RUN_LOCK_TIMEOUT"] = "5s; drop table t"
            with self.assertRaises(d.Refused):
                d.build(self.out, self.probe, [m])
        finally:
            del os.environ["DB_DRY_RUN_LOCK_TIMEOUT"]
            del os.environ["DB_DRY_RUN_STATEMENT_TIMEOUT"]


def marker(results):
    return d.MARK_START + json.dumps(results) + d.MARK_END


class FindResults(unittest.TestCase):
    RESULTS = [{"check": "a", "ok": True, "detail": None}, {"check": "b", "ok": False, "detail": "x:DRY_RUN_END y"}]

    def test_management_api_shape(self):
        body = json.dumps({"message": "failed to run sql query: ERROR:  " + marker(self.RESULTS) + "\nCONTEXT: PL/pgSQL function inline_code_block line 8 at RAISE"})
        results, problem = d.find_results(body)
        self.assertIsNone(problem)
        self.assertEqual(results, self.RESULTS)

    def test_pg_meta_shape_with_formatted_error(self):
        body = json.dumps({"message": marker(self.RESULTS), "formattedError": "ERROR:  P0001:  " + marker(self.RESULTS), "code": "P0001"})
        self.assertEqual(d.find_results(body)[0], self.RESULTS)

    def test_wrapped_json_string(self):
        inner = json.dumps({"error": {"message": marker(self.RESULTS)}})
        body = json.dumps({"message": inner})
        self.assertEqual(d.find_results(body)[0], self.RESULTS)

    def test_psql_stderr_plain_text(self):
        body = "ERROR:  " + marker(self.RESULTS) + "\nCONTEXT:  PL/pgSQL function inline_code_block line 8 at RAISE\n"
        self.assertEqual(d.find_results(body)[0], self.RESULTS)

    def test_absent(self):
        self.assertEqual(d.find_results(json.dumps({"message": "ERROR: relation x does not exist"})), (None, None))

    def test_cut_short(self):
        body = json.dumps({"message": d.MARK_START + '[{"check": "a", "ok": tr'})
        results, problem = d.find_results(body)
        self.assertIsNone(results)
        self.assertIn("cut short", problem)

    def test_missing_end_marker(self):
        body = json.dumps({"message": d.MARK_START + "[]" + " something else"})
        results, problem = d.find_results(body)
        self.assertIsNone(results)
        self.assertIn("did not end", problem)


class Judge(unittest.TestCase):
    def run_judge(self, status, body, env=None):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
            fh.write(body)
            path = fh.name
        saved = dict(os.environ)
        os.environ.update(env or {})
        out = StringIO()
        try:
            with redirect_stdout(out):
                code = d.judge(status, path, "testref")
        finally:
            os.environ.clear()
            os.environ.update(saved)
            os.unlink(path)
        return code, out.getvalue()

    def api(self, results, prefix="failed to run sql query: ERROR:  "):
        return json.dumps({"message": prefix + marker(results) + "\nCONTEXT: PL/pgSQL function inline_code_block line 8 at RAISE"})

    def test_every_check_passing_is_success(self):
        code, out = self.run_judge("400", self.api([{"check": "one", "ok": True, "detail": "d"}, {"check": "two", "ok": True, "detail": None}]))
        self.assertEqual(code, 0, out)
        self.assertIn("OK: all 2 checks passed", out)
        self.assertIn("ok    one", out)
        self.assertIn("rolled back", out)
        self.assertIn("testref", out)

    def test_a_false_check_fails_and_is_named(self):
        code, out = self.run_judge("400", self.api([{"check": "fine", "ok": True}, {"check": "clock_out moved", "ok": False, "detail": "9999 != 600"}]))
        self.assertEqual(code, 1)
        self.assertIn("FAIL  clock_out moved", out)
        self.assertIn("9999 != 600", out)
        self.assertIn("1 of 2 checks failed", out)

    def test_no_checks_at_all_fails(self):
        code, out = self.run_judge("400", self.api([]))
        self.assertEqual(code, 1)
        self.assertIn("recorded no checks", out)

    def test_an_earlier_sql_error_is_the_change_being_broken(self):
        body = json.dumps({"message": 'failed to run sql query: ERROR:  new row for relation "movements" violates check constraint "movements_one_subject_ck"'})
        code, out = self.run_judge("400", body)
        self.assertEqual(code, 1)
        self.assertIn("the change is broken", out)
        self.assertIn("movements_one_subject_ck", out)
        self.assertIn("nothing was kept", out)

    def test_a_lock_timeout_is_not_a_broken_change(self):
        body = json.dumps({"message": "failed to run sql query: ERROR:  canceling statement due to lock timeout"})
        code, out = self.run_judge("400", body)
        self.assertEqual(code, 3)
        self.assertIn("COULD NOT TELL", out)
        self.assertIn("Run it again", out)

    SETUP = ('dry run: no QA login has the installer role — set qa.installer ("TEST — automation, do not assign") '
             "to Installer in the app; use dry_run_pick_real('installer') if the probe means a real person.")

    def test_a_setup_refusal_is_not_the_change_being_broken(self):
        # The harness stopping before the change was tried: every shape the
        # answer arrives in. The first is what the Management API really sent
        # on 2026-09-24, with the harness's sentence in place of the fence's.
        for body in (json.dumps({"message": "Failed to run sql query: ERROR:  P0001: " + self.SETUP}),
                     json.dumps({"message": self.SETUP, "formattedError": "ERROR:  P0001:  " + self.SETUP, "code": "P0001"}),
                     "ERROR:  " + self.SETUP + "\nCONTEXT:  PL/pgSQL function pg_temp_3.dry_run_pick(text) line 14 at RAISE\n"):
            code, out = self.run_judge("400", body)
            self.assertEqual(code, 3, out)
            self.assertIn("COULD NOT TELL", out)
            self.assertIn("the change was not tried", out)
            self.assertIn("set qa.installer", out)
            self.assertNotIn("the change is broken", out)

    def test_the_words_dry_run_inside_a_real_error_are_still_the_change(self):
        # Only a message that STARTS "dry run:" is the harness's. The change's
        # own error that happens to say it is still the change failing.
        body = json.dumps({"message": "Failed to run sql query: ERROR:  22023: Nothing is saved in a dry run: turn it off first."})
        code, out = self.run_judge("400", body)
        self.assertEqual(code, 1, out)
        self.assertIn("the change is broken", out)

    def test_a_2xx_without_the_marker_is_alarming(self):
        code, out = self.run_judge("201", "[]")
        self.assertEqual(code, 3)
        self.assertIn("WITHOUT its forced error", out)
        self.assertIn("nothing as proven", out)

    def test_token_and_project_problems_could_not_tell(self):
        code, out = self.run_judge("401", json.dumps({"message": "Unauthorized"}))
        self.assertEqual(code, 3)
        self.assertIn("token", out)
        code, out = self.run_judge("000", "")
        self.assertEqual(code, 3)

    def test_a_cut_short_answer_could_not_tell(self):
        code, out = self.run_judge("400", json.dumps({"message": d.MARK_START + "[{"}))
        self.assertEqual(code, 3)
        self.assertIn("did not survive the trip", out)

    def test_psql_stderr_is_readable_too(self):
        body = "ERROR:  " + marker([{"check": "x", "ok": True}]) + "\nCONTEXT:  PL/pgSQL function inline_code_block line 8 at RAISE\n"
        code, out = self.run_judge("400", body)
        self.assertEqual(code, 0, out)

    def test_the_token_and_emails_never_reach_the_output(self):
        # Not shaped like a real token on purpose: GitHub's push protection
        # (rightly) refuses a commit carrying sbp_ + 40 hex characters.
        token = "sbp_TEST_not_a_real_token_never_shown"
        results = [{"check": "leaky", "ok": False, "detail": f"token {token} for qa.installer@crew.example.app"}]
        code, out = self.run_judge("400", self.api(results), env={"SUPABASE_ACCESS_TOKEN": token})
        self.assertEqual(code, 1)
        self.assertNotIn(token, out)
        self.assertNotIn("qa.installer@", out)
        self.assertIn("[token]", out)
        self.assertIn("[email]", out)
        body = json.dumps({"message": f"Unauthorized for {token}"})
        code, out = self.run_judge("401", body, env={"SUPABASE_ACCESS_TOKEN": token})
        self.assertNotIn(token, out)


if __name__ == "__main__":
    unittest.main(verbosity=1)

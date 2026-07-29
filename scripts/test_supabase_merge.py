#!/usr/bin/env python3
"""Unit tests for the Supabase inventory / compare / merge tooling.

    python3 scripts/test_supabase_merge.py

Stdlib only, on purpose: this has to run on a laptop with a Supabase token and
nothing else installed.

The fixture is the real pre-repair backup committed at
docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json — 374 rows of
actual production data. Ammon's project is simulated by re-issuing UUIDs on that
same data, which is exactly the situation the merge has to survive: two
databases holding the same real-world things under different ids.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import random
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from supabase_merge_lib import (
    ADVISORY,
    DEDUP_KEYS,
    DEFERRED_FK_EDGES,
    EMPTY,
    ENFORCED,
    MISSING,
    POPULATED,
    SURROGATE_ONLY,
    IdRemapper,
    compare_inventories,
    dedup_key_enforcement,
    dependency_cycles,
    dependency_order,
    inventory_from_backup,
    is_uuid,
    migration_leader,
    natural_key_of,
    parse_migrations,
    total_rows,
)
from supabase_merge_plan import Plan, insert_statement, sql_literal

# supabase-compare.py is not an importable module name, so load it by path.
_compare_spec = importlib.util.spec_from_file_location(
    "supabase_compare", Path(__file__).resolve().parent / "supabase-compare.py"
)
supabase_compare = importlib.util.module_from_spec(_compare_spec)
_compare_spec.loader.exec_module(supabase_compare)

REPO = Path(__file__).resolve().parent.parent
BACKUP = REPO / "docs" / "backups" / "2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json"

SCHEMA = parse_migrations()
RAW_BACKUP = json.loads(BACKUP.read_text())


def other_project(seed: int = 7) -> dict:
    """The backup with fresh UUIDs on its reference tables, as a second project.

    This is what actually happened: both people seeded `window_types`,
    `cost_codes`, `locations` and `projects` from the same source material, and
    each database generated its own ids. Child rows are rewritten to follow, so
    the fixture is internally consistent — a merge that ignores the remap
    duplicates every one of those rows.
    """
    other = copy.deepcopy(RAW_BACKUP)
    other["project_id"] = "jvsyhtarnvmdilsgksdi"
    rnd = random.Random(seed)

    remap: dict[str, str] = {}
    for table in ("window_types", "cost_codes", "locations", "projects", "windows"):
        for row in other.get(table, []):
            new = str(uuid.UUID(int=rnd.getrandbits(128), version=4))
            remap[row["id"]] = new
            row["id"] = new

    for table, rows in other.items():
        if not isinstance(rows, list):
            continue
        spec = SCHEMA.tables.get(table)
        if spec is None:
            continue
        for row in rows:
            for fk in spec.foreign_keys:
                for col in fk.columns:
                    if row.get(col) in remap:
                        row[col] = remap[row[col]]
    return other


class TestSchemaParsing(unittest.TestCase):
    def test_every_migration_parsed(self):
        self.assertEqual(SCHEMA.unparsed, [])

    def test_recovers_the_expected_tables(self):
        # 72 tables declared by the migrations: 67, plus the five AI spend
        # meters. Production reported one more base table than the migrations
        # declare; the extra is `project_marks`, which no migration declares.
        self.assertEqual(len(SCHEMA.tables), 72)
        for expected in ("window_types", "windows", "profiles", "project_openings"):
            self.assertIn(expected, SCHEMA)

    def test_foreign_keys_are_recovered_with_their_targets(self):
        windows = SCHEMA["windows"]
        targets = {fk.ref_table for fk in windows.foreign_keys}
        self.assertEqual(targets, {"window_types", "projects", "locations"})

    def test_auth_reference_is_recognised_and_excluded_from_ordering(self):
        profiles = SCHEMA["profiles"]
        auth_fks = [fk for fk in profiles.foreign_keys if fk.is_auth]
        self.assertEqual(len(auth_fks), 1)
        self.assertEqual(auth_fks[0].ref_table, "auth.users")
        self.assertNotIn("auth.users", profiles.parents())

    def test_profiles_has_no_email_column(self):
        # Worth pinning: `profiles.email` reads like the obvious way to match
        # crew across two projects, and it does not exist. The only handle is
        # auth.users.email, which lives in a schema SQL cannot insert into.
        self.assertNotIn("email", SCHEMA["profiles"].columns)

    def test_generated_columns_are_flagged(self):
        self.assertEqual(SCHEMA["locations"].generated, {"address"})
        self.assertNotIn(
            "address", SCHEMA["locations"].insertable_columns(["address", "zone"])
        )

    def test_unique_constraints_from_inline_and_create_index(self):
        self.assertIn(("zone", "rack", "slot"), SCHEMA["locations"].uniques)
        self.assertIn(("serial",), SCHEMA["locations"].uniques)  # create unique index
        self.assertIn(("window_id",), SCHEMA["windows"].uniques)

    def test_function_bodies_do_not_invent_foreign_keys(self):
        # `$$ ... $$` bodies are full of insert/select text; parsing them as DDL
        # would attach phantom foreign keys to whatever table came before.
        self.assertEqual(SCHEMA["window_id_counters"].parents(), {"window_types"})


class TestDependencyOrder(unittest.TestCase):
    def test_every_parent_precedes_its_children(self):
        order = dependency_order(SCHEMA)
        self.assertEqual(len(order), len(SCHEMA.tables))
        position = {name: i for i, name in enumerate(order)}
        deferred = {(t, c) for t, c in DEFERRED_FK_EDGES}
        for name, table in SCHEMA.tables.items():
            for fk in table.foreign_keys:
                if fk.is_auth or fk.ref_table == name:
                    continue
                if any((name, c) in deferred for c in fk.columns):
                    continue
                self.assertLess(
                    position[fk.ref_table],
                    position[name],
                    f"{name} inserted before its parent {fk.ref_table}",
                )

    def test_the_schema_really_does_have_a_cycle(self):
        cycles = dependency_cycles(SCHEMA)
        self.assertEqual(len(cycles), 1)
        self.assertEqual(
            cycles[0], ["install_events", "project_openings", "window_types", "windows"]
        )

    def test_deferring_one_nullable_edge_breaks_every_cycle(self):
        self.assertEqual(dependency_cycles(SCHEMA, apply_deferrals=True), [])

    def test_deferred_edges_are_nullable(self):
        for table, column in DEFERRED_FK_EDGES:
            self.assertIn(column, SCHEMA[table].columns)
            self.assertNotIn(column, SCHEMA[table].primary_key)

    def test_subset_ordering_ignores_absent_parents(self):
        order = dependency_order(SCHEMA, ["movements", "windows"])
        self.assertEqual(order, ["windows", "movements"])


class TestDedupKeys(unittest.TestCase):
    def test_every_table_has_a_decision(self):
        undecided = sorted(set(SCHEMA.tables) - set(DEDUP_KEYS))
        self.assertEqual(undecided, [], f"no dedup decision for: {undecided}")

    def test_no_dedup_key_for_a_table_that_does_not_exist(self):
        stale = sorted(set(DEDUP_KEYS) - set(SCHEMA.tables))
        self.assertEqual(stale, [])

    def test_every_key_column_exists(self):
        for table, key in DEDUP_KEYS.items():
            for column in key or ():
                self.assertIn(
                    column,
                    set(SCHEMA[table].columns) | set(SCHEMA[table].primary_key),
                    f"{table}.{column} does not exist",
                )

    def test_enforcement_is_classified_from_the_schema(self):
        self.assertEqual(dedup_key_enforcement(SCHEMA, "window_types"), ENFORCED)
        self.assertEqual(dedup_key_enforcement(SCHEMA, "locations"), ENFORCED)
        # `cost_codes.code` reads like a key and carries no UNIQUE index, so
        # both projects can already hold two rows with code '100'.
        self.assertEqual(dedup_key_enforcement(SCHEMA, "cost_codes"), ADVISORY)
        self.assertEqual(dedup_key_enforcement(SCHEMA, "supplies"), ADVISORY)
        self.assertEqual(dedup_key_enforcement(SCHEMA, "movements"), SURROGATE_ONLY)

    def test_natural_key_is_case_and_whitespace_insensitive(self):
        a = natural_key_of("window_types", {"type_code": "CAS3050"})
        b = natural_key_of("window_types", {"type_code": " cas3050 "})
        self.assertEqual(a, b)

    def test_natural_key_is_none_without_a_key_or_without_the_column(self):
        self.assertIsNone(natural_key_of("movements", {"id": "x"}))
        self.assertIsNone(natural_key_of("window_types", {"id": "x"}))

    def test_a_null_key_column_is_not_a_key(self):
        # `vehicles.vin` is `text null`. Two vehicles with no VIN recorded are
        # two vehicles, not one.
        self.assertIsNone(natural_key_of("vehicles", {"id": "a", "vin": None}))

    def test_rows_with_a_null_key_are_never_matched_to_each_other(self):
        target = [{"id": "aaa", "vin": None}]
        source = [{"id": "bbb", "vin": None}]
        remapper = IdRemapper(SCHEMA)
        self.assertEqual(remapper.learn("vehicles", source, target), {})
        self.assertEqual(remapper.resolve("vehicles", "bbb"), "bbb")


class TestBackupFixture(unittest.TestCase):
    def test_the_committed_backup_reads_as_374_rows(self):
        inv = inventory_from_backup(BACKUP)
        self.assertEqual(inv["project_ref"], "czprjcskmzzagdztqonm")
        self.assertEqual(total_rows(inv), 374)
        self.assertEqual(len(inv["tables"]), 18)

    def test_tables_absent_from_the_backup_are_unknown_not_zero(self):
        inv = inventory_from_backup(BACKUP)
        # The backup only holds non-empty tables. `issues` was empty and is not
        # in the file, so the inventory must not claim to know it is empty.
        self.assertNotIn("issues", inv["tables"])
        self.assertIsNone(inv["migrations"]["count"])


class TestComparison(unittest.TestCase):
    def _inv(self, ref, tables, **extra):
        base = {
            "project_ref": ref,
            "tables": tables,
            "migrations": {"count": None},
            "auth": {"users": None},
            "storage": {"buckets": []},
            "functions": [],
        }
        base.update(extra)
        return base

    def test_missing_and_empty_are_never_conflated(self):
        a = self._inv("aaa", {"windows": {"rows": 11, "columns": {}}})
        b = self._inv(
            "bbb",
            {
                "windows": {"rows": 0, "columns": {}},
                "issues": {"rows": 0, "columns": {}},
            },
        )
        by_table = {c.table: c for c in compare_inventories([a, b])}

        self.assertEqual(by_table["windows"].states, {"aaa": POPULATED, "bbb": EMPTY})
        self.assertEqual(
            by_table["windows"].verdict, "empty in some projects, populated in others"
        )
        # `issues` exists in bbb and does NOT exist in aaa. That is the exact
        # distinction that got missed once: 31 tables were absent, and a report
        # that reads 0 for both cases called the database clean.
        self.assertEqual(by_table["issues"].states, {"aaa": MISSING, "bbb": EMPTY})
        self.assertTrue(by_table["issues"].missing_somewhere)
        self.assertEqual(
            by_table["issues"].verdict, "missing in some projects (no data anywhere)"
        )

    def test_missing_while_data_exists_elsewhere_is_escalated(self):
        a = self._inv("aaa", {"trips": {"rows": 4, "columns": {}}})
        b = self._inv("bbb", {})
        comparison = compare_inventories([a, b])[0]
        self.assertEqual(comparison.verdict, "MISSING WHERE DATA EXISTS ELSEWHERE")

    def test_column_differences_are_reported_per_column(self):
        a = self._inv("aaa", {"t": {"rows": 1, "columns": {"id": "uuid", "note": "text"}}})
        b = self._inv("bbb", {"t": {"rows": 1, "columns": {"id": "uuid"}}})
        comparison = compare_inventories([a, b])[0]
        self.assertEqual(comparison.column_only_in, {"note": ["aaa"]})

    def test_column_type_differences_are_reported(self):
        a = self._inv("aaa", {"t": {"rows": 1, "columns": {"width_in": "integer"}}})
        b = self._inv("bbb", {"t": {"rows": 1, "columns": {"width_in": "numeric"}}})
        comparison = compare_inventories([a, b])[0]
        self.assertEqual(
            comparison.type_differences,
            {"width_in": {"aaa": "integer", "bbb": "numeric"}},
        )

    def test_a_table_with_no_column_information_is_not_a_schema_finding(self):
        # A backup-derived inventory learns columns from rows, so an empty table
        # reports no columns. That is missing information, not a missing column.
        a = self._inv("aaa", {"t": {"rows": 8, "columns": {"id": "uuid"}}})
        b = self._inv("bbb", {"t": {"rows": 0, "columns": {}}})
        comparison = compare_inventories([a, b])[0]
        self.assertEqual(comparison.column_only_in, {})

    def test_needs_two_inventories(self):
        with self.assertRaises(ValueError):
            compare_inventories([self._inv("aaa", {})])

    def test_migration_leader(self):
        a = self._inv("aaa", {}, migrations={"count": 70})
        b = self._inv("bbb", {}, migrations={"count": 44})
        c = self._inv("ccc", {}, migrations={"count": None})
        lead = migration_leader([a, b, c])
        self.assertEqual(lead["leader"], "aaa")
        self.assertEqual(lead["spread"], 26)
        self.assertEqual(lead["unknown"], ["ccc"])

    def test_real_backup_against_a_reissued_copy(self):
        a = inventory_from_backup(BACKUP)
        other = other_project()
        path = Path(self.tmp) / "other.json"
        path.write_text(json.dumps(other))
        b = inventory_from_backup(path)
        comparisons = compare_inventories([a, b])
        # Same rows on both sides: row counts match everywhere even though every
        # reference-table id differs. Counts alone cannot detect the duplication.
        self.assertTrue(all(c.verdict == "identical row counts" for c in comparisons))

    def setUp(self):
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.addCleanup(self._tmp.cleanup)


class TestUninitialisedProject(unittest.TestCase):
    """A project with no public schema at all must not be compared table by table.

    Found on 2026-07-29: the account held a third project, nbjmylctlklvazzlybts,
    created and never touched. Including it turned all 67 tables into
    "MISSING WHERE DATA EXISTS ELSEWHERE" and made the tool exit non-zero, which
    is the opposite of the truth — an empty project has nothing to merge.
    """

    def _inv(self, ref, tables):
        return {
            "project_ref": ref,
            "tables": tables,
            "migrations": {"count": None},
            "auth": {"users": 0},
            "storage": {"buckets": [], "total_objects": 0},
            "functions": [],
        }

    def test_no_tables_is_uninitialised(self):
        self.assertTrue(supabase_compare.is_uninitialised(self._inv("ccc", {})))

    def test_tables_that_are_all_empty_are_still_compared(self):
        # Empty is not missing. A project whose tables exist but hold no rows has
        # a schema, and excluding it would recreate the bug this repo already had.
        inv = self._inv("bbb", {"issues": {"rows": 0, "columns": {}}})
        self.assertFalse(supabase_compare.is_uninitialised(inv))

    def test_empty_project_does_not_mask_a_real_comparison(self):
        a = self._inv("aaa", {"windows": {"rows": 11, "columns": {}}})
        b = self._inv("bbb", {"windows": {"rows": 0, "columns": {}}})
        empty = self._inv("ccc", {})

        comparable = [i for i in (a, b, empty) if not supabase_compare.is_uninitialised(i)]
        self.assertEqual([i["project_ref"] for i in comparable], ["aaa", "bbb"])

        comparisons = compare_inventories(comparable)
        self.assertEqual(
            [c.verdict for c in comparisons],
            ["empty in some projects, populated in others"],
        )
        self.assertNotIn(MISSING, comparisons[0].states.values())

    def test_render_names_the_excluded_project(self):
        a = self._inv("aaa", {"windows": {"rows": 11, "columns": {}}})
        b = self._inv("bbb", {"windows": {"rows": 0, "columns": {}}})
        empty = self._inv("ccc", {})
        out = supabase_compare.render([a, b], compare_inventories([a, b]), [empty])
        self.assertIn("NOT COMPARED", out)
        self.assertIn("ccc", out)


class TestIdRemapper(unittest.TestCase):
    def test_matches_on_natural_key_and_records_the_change(self):
        target = RAW_BACKUP["window_types"]
        source = other_project()["window_types"]
        remapper = IdRemapper(SCHEMA)
        changed = remapper.learn("window_types", source, target)

        self.assertEqual(len(changed), 130, "every reissued id should remap")
        by_code = {r["type_code"]: r["id"] for r in target}
        for row in source:
            self.assertEqual(
                remapper.resolve("window_types", row["id"]), by_code[row["type_code"]]
            )

    def test_unmatched_rows_keep_their_own_id(self):
        target = [{"id": "11111111-1111-4111-8111-111111111111", "type_code": "CAS3050"}]
        source = [
            {"id": "22222222-2222-4222-8222-222222222222", "type_code": "CAS3050"},
            {"id": "33333333-3333-4333-8333-333333333333", "type_code": "BRANDNEW"},
        ]
        remapper = IdRemapper(SCHEMA)
        remapper.learn("window_types", source, target)
        self.assertEqual(
            remapper.resolve("window_types", source[0]["id"]), target[0]["id"]
        )
        self.assertEqual(
            remapper.resolve("window_types", source[1]["id"]), source[1]["id"]
        )
        self.assertEqual(remapper.collisions, [])

    def test_same_uuid_different_thing_gets_a_fresh_id(self):
        shared = "44444444-4444-4444-8444-444444444444"
        target = [{"id": shared, "type_code": "CAS3050"}]
        source = [{"id": shared, "type_code": "SLIDER9000"}]
        remapper = IdRemapper(SCHEMA)
        remapper.learn("window_types", source, target)

        resolved = remapper.resolve("window_types", shared)
        self.assertNotEqual(resolved, shared)
        self.assertTrue(is_uuid(resolved))
        self.assertEqual(len(remapper.collisions), 1)
        self.assertEqual(remapper.collisions[0]["table"], "window_types")

    def test_child_rows_follow_a_remapped_parent(self):
        source = other_project()
        remapper = IdRemapper(SCHEMA)
        remapper.learn("window_types", source["window_types"], RAW_BACKUP["window_types"])
        remapper.learn("projects", source["projects"], RAW_BACKUP["projects"])

        target_types = {r["type_code"]: r["id"] for r in RAW_BACKUP["window_types"]}
        source_types = {r["id"]: r["type_code"] for r in source["window_types"]}

        child = source["project_windows"][0]
        remapped = remapper.remap_row("project_windows", child)

        self.assertNotEqual(remapped["window_type_id"], child["window_type_id"])
        self.assertEqual(
            remapped["window_type_id"], target_types[source_types[child["window_type_id"]]]
        )
        # project_windows itself has no natural-key remap, so its own id is kept.
        self.assertEqual(remapped["id"], child["id"])

    def test_remap_never_rewrites_an_auth_reference(self):
        remapper = IdRemapper(SCHEMA)
        remapper.add("auth.users", "aaa", "bbb")
        row = {"id": "aaa", "display_name": "Dave"}
        self.assertEqual(remapper.remap_row("profiles", row)["id"], "aaa")

    def test_null_foreign_keys_stay_null(self):
        remapper = IdRemapper(SCHEMA)
        row = {"id": "x", "window_type_id": None, "project_id": None, "location_id": None}
        self.assertIsNone(remapper.remap_row("windows", row)["project_id"])

    def test_is_uuid(self):
        self.assertTrue(is_uuid("11111111-1111-4111-8111-111111111111"))
        self.assertFalse(is_uuid("SLOT-000001"))
        self.assertFalse(is_uuid(None))
        self.assertFalse(is_uuid(42))


class TestSqlRendering(unittest.TestCase):
    def test_quotes_are_escaped(self):
        self.assertEqual(sql_literal("O'Brien"), "'O''Brien'")

    def test_json_columns_are_cast(self):
        self.assertEqual(sql_literal({"a": 1}), "'{\"a\": 1}'::jsonb")

    def test_nulls_and_booleans(self):
        self.assertEqual(sql_literal(None), "null")
        self.assertEqual(sql_literal(True), "true")

    def test_generated_columns_are_dropped_from_inserts(self):
        stmt = insert_statement(
            "locations",
            {"id": "x", "zone": "S", "rack": "03", "slot": "A", "address": "S-03-A"},
            ("zone", "rack", "slot"),
            generated=("address",),
        )
        self.assertNotIn("address", stmt)
        self.assertIn("on conflict (zone, rack, slot) do nothing", stmt)


class TestPlan(unittest.TestCase):
    def _plan(self, source_raw, target_raw, limit=0):
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        s = Path(tmp.name) / "s.json"
        t = Path(tmp.name) / "t.json"
        s.write_text(json.dumps(source_raw))
        t.write_text(json.dumps(target_raw))
        return Plan(
            SCHEMA,
            inventory_from_backup(s),
            inventory_from_backup(t),
            {k: v for k, v in source_raw.items() if isinstance(v, list)},
            {k: v for k, v in target_raw.items() if isinstance(v, list)},
            limit,
        )

    def test_tables_are_planned_in_dependency_order(self):
        plan = self._plan(other_project(), RAW_BACKUP)
        tables = plan.tables_to_move()
        self.assertLess(tables.index("window_types"), tables.index("windows"))
        self.assertLess(tables.index("windows"), tables.index("movements"))
        self.assertLess(tables.index("projects"), tables.index("project_windows"))

    def test_counter_tables_are_never_merged(self):
        plan = self._plan(other_project(), RAW_BACKUP)
        self.assertNotIn("window_id_counters", plan.tables_to_move())

    def test_a_table_missing_from_the_target_is_a_blocker_not_an_insert(self):
        target = {k: v for k, v in RAW_BACKUP.items() if k != "tools"}
        plan = self._plan(other_project(), target)
        plan.statements()
        self.assertTrue(any(b.startswith("tools:") for b in plan.blockers))

    def test_statements_carry_the_remapped_parent_id(self):
        source = other_project()
        plan = self._plan(source, RAW_BACKUP, limit=0)
        statements = dict(plan.statements())
        target_types = {r["type_code"]: r["id"] for r in RAW_BACKUP["window_types"]}
        joined = "\n".join(statements["project_windows"])
        # Every window_type_id written must be a target id, never a source one.
        for row in source["window_types"]:
            self.assertNotIn(row["id"], joined)
        self.assertTrue(any(tid in joined for tid in target_types.values()))

    def test_verification_covers_every_natural_key(self):
        plan = self._plan(other_project(), RAW_BACKUP)
        text = "\n".join(plan.verification())
        for table, key in DEDUP_KEYS.items():
            if key:
                self.assertIn(f"from public.{table}\n", text)

    def test_preflight_asks_about_advisory_keys_and_auth(self):
        plan = self._plan(other_project(), RAW_BACKUP)
        text = "\n".join(plan.preflight())
        self.assertIn("from public.cost_codes", text)
        self.assertIn("auth.users", text)
        self.assertIn("SLOT-", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)

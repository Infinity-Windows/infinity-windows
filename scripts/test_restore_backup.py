#!/usr/bin/env python3
"""Tests for the restore planner and SQL generator.

    python3 scripts/test_restore_backup.py

Offline, stdlib only. Small hand-built snapshots prove the two things that
would make a restore wrong: children inserted before parents, and a value that
does not come back as itself (a quote, a JSON document, an array, a timestamp).
The last case runs the generator over the committed July snapshot so the real
shape of a dump — every column type it actually contains — is exercised.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import restore_backup as rb  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
JULY = REPO / "docs/backups/2026-07-29T2046Z-czprjcskmzzagdztqonm-full.json"


def snapshot() -> dict:
    def col(table, name, data_type, udt):
        return {"schema": "public", "table": table, "column": name, "data_type": data_type, "udt_name": udt}

    return {
        "exported_at": "2026-09-06T09:20:00.000Z",
        "_meta": {
            "project_ref": "ref",
            "total_rows": 4,
            "tables": [
                {"schema": "public", "table": "child", "captured": True, "json_key": "child", "row_count": 1},
                {"schema": "public", "table": "parent", "captured": True, "json_key": "parent", "row_count": 2},
                {"schema": "public", "table": "loner", "captured": True, "json_key": "loner", "row_count": 1},
                {"schema": "public", "table": "empty", "captured": False, "row_count": 0},
            ],
            "redactions": ["public.parent.pin_hash: 1 value(s) redacted"],
        },
        "_schema": {
            "foreign_keys": [
                {"schema": "public", "table": "child", "references_schema": "public", "references_table": "parent"},
                {"schema": "public", "table": "child", "references_schema": "public", "references_table": "child"},
                {"schema": "public", "table": "child", "references_schema": "auth", "references_table": "users"},
            ],
            "columns": [
                col("parent", "id", "uuid", "uuid"),
                col("parent", "name", "text", "text"),
                col("parent", "pin_hash", "text", "text"),
                col("parent", "meta", "jsonb", "jsonb"),
                col("parent", "tags", "ARRAY", "_text"),
                col("parent", "at", "timestamp with time zone", "timestamptz"),
                col("parent", "n", "integer", "int4"),
                col("parent", "price", "numeric", "numeric"),
                col("parent", "ok", "boolean", "bool"),
                col("child", "id", "uuid", "uuid"),
                col("child", "parent_id", "uuid", "uuid"),
                col("loner", "id", "integer", "int4"),
            ],
        },
        "parent": [
            {"id": "11111111-1111-1111-1111-111111111111", "name": "O'Brien's", "pin_hash": "[REDACTED-CREDENTIAL]",
             "meta": {"b": 1, "a": [1, 2]}, "tags": "{x,\"y z\"}", "at": "2026-07-18 02:18:53.2+00",
             "n": 7, "price": "2.50", "ok": True},
            {"id": "22222222-2222-2222-2222-222222222222", "name": None, "pin_hash": None,
             "meta": None, "tags": None, "at": None, "n": None, "price": None, "ok": False},
        ],
        "child": [{"id": "33333333-3333-3333-3333-333333333333", "parent_id": "11111111-1111-1111-1111-111111111111"}],
        "loner": [{"id": 1}],
        "_auth": {"user_count": 2},
        "_storage": {"object_count": 3, "objects": [{"sha256": "x"}, {}, {}]},
        "_migrations": [],
    }


class Order(unittest.TestCase):
    def test_parents_come_before_children(self):
        ordered, cyclic = rb.restore_order(snapshot())
        self.assertEqual(cyclic, [])
        self.assertLess(ordered.index(("public", "parent")), ordered.index(("public", "child")))
        self.assertIn(("public", "loner"), ordered)
        self.assertNotIn(("public", "empty"), ordered)

    def test_self_reference_and_reference_outside_the_snapshot_do_not_block(self):
        ordered, cyclic = rb.restore_order(snapshot())
        self.assertIn(("public", "child"), ordered)

    def test_a_real_cycle_is_reported_not_silently_dropped(self):
        snap = snapshot()
        snap["_schema"]["foreign_keys"].append(
            {"schema": "public", "table": "parent", "references_schema": "public", "references_table": "child"}
        )
        ordered, cyclic = rb.restore_order(snap)
        self.assertEqual(cyclic, [("public", "child"), ("public", "parent")])
        self.assertEqual(ordered, [("public", "loner")])
        self.assertIn("foreign-key cycle", rb.plan(snap))
        self.assertIn("NOT restored here", rb.render_restore_sql(snap))


class Literals(unittest.TestCase):
    def types(self):
        return rb.column_types(snapshot())

    def lit(self, column, value):
        return rb.sql_literal(value, self.types()[("public", "parent", column)])

    def test_null_and_booleans(self):
        self.assertEqual(self.lit("name", None), "NULL")
        self.assertEqual(self.lit("ok", True), "true")
        self.assertEqual(self.lit("ok", False), "false")

    def test_quote_in_text_is_doubled(self):
        self.assertEqual(self.lit("name", "O'Brien's"), "'O''Brien''s'")

    def test_json_is_cast_and_sorted(self):
        self.assertEqual(self.lit("meta", {"b": 1, "a": [1, 2]}), "'{\"a\": [1, 2], \"b\": 1}'::jsonb")

    def test_array_literal_is_cast_to_the_element_type(self):
        self.assertEqual(self.lit("tags", '{x,"y z"}'), "'{x,\"y z\"}'::\"text\"[]")

    def test_timestamp_uuid_numeric_are_cast(self):
        self.assertEqual(self.lit("at", "2026-07-18 02:18:53.2+00"), "'2026-07-18 02:18:53.2+00'::\"timestamptz\"")
        self.assertEqual(self.lit("id", "1111"), "'1111'::\"uuid\"")
        self.assertEqual(self.lit("price", "2.50"), "'2.50'::\"numeric\"")
        self.assertEqual(self.lit("n", 7), "7")

    def test_unknown_column_falls_back_to_plain_text(self):
        self.assertEqual(rb.sql_literal("x", None), "'x'")
        self.assertEqual(rb.sql_literal({"k": 1}, None), "'{\"k\": 1}'::jsonb")


class Rendering(unittest.TestCase):
    def test_sql_is_one_transaction_with_triggers_off_and_back_on(self):
        sql = rb.render_restore_sql(snapshot())
        self.assertTrue(sql.startswith("-- Restore of project ref"))
        self.assertIn("begin;", sql)
        self.assertTrue(sql.rstrip().endswith("commit;"))
        self.assertIn('alter table "public"."parent" disable trigger user;', sql)
        self.assertIn('alter table "public"."parent" enable trigger user;', sql)
        self.assertLess(sql.index('insert into "public"."parent"'), sql.index('insert into "public"."child"'))
        self.assertIn("[REDACTED-CREDENTIAL]", sql)

    def test_plan_names_what_needs_a_person(self):
        text = rb.plan(snapshot())
        self.assertIn("public.parent  2 rows", text)
        self.assertIn("pin_hash", text)
        self.assertIn("2 auth users", text)
        self.assertIn("3 storage objects are inventoried; 1 have their bytes", text)

    def test_the_committed_july_snapshot_renders_end_to_end(self):
        snap = rb.load_snapshot(str(JULY))
        ordered, cyclic = rb.restore_order(snap)
        self.assertEqual(cyclic, [], "the real schema has no FK cycle among captured tables")
        self.assertGreater(len(ordered), 20)
        sql = rb.render_restore_sql(snap)
        self.assertEqual(sql.count("insert into "), len(ordered))
        # Every captured row is in the SQL: count the value tuples per table.
        for s, t in ordered:
            key = t if s == "public" else f"{s}.{t}"
            rows = snap[key]
            block = sql.split(f'insert into "{s}"."{t}"', 1)[1].split("insert into", 1)[0]
            self.assertEqual(block.count("\n  ("), len(rows), f"{s}.{t}")
        plan = rb.plan(snap)
        self.assertIn("Order (parents first", plan)

    def test_load_snapshot_reads_gzip_too(self):
        import gzip, json, tempfile, os
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.json.gz")
            with gzip.open(p, "wb") as fh:
                fh.write(json.dumps(snapshot()).encode())
            self.assertEqual(rb.load_snapshot(p)["_meta"]["project_ref"], "ref")


if __name__ == "__main__":
    unittest.main(verbosity=1)

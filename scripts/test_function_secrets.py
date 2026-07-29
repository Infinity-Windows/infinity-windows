#!/usr/bin/env python3
"""Unit tests for the edge-function secret enumerator.

    python3 scripts/test_function_secrets.py

Stdlib only. Most cases build a throwaway supabase/functions tree so the rules
are tested in isolation, and the last group asserts the answers this repo's real
functions produce — because the point of deriving them from source is that the
derivation is right, and a subtly wrong answer here is worse than no check at
all. It would send an owner off to set a secret a function never reads.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import function_secrets as fs


class Tree:
    """A throwaway supabase/functions directory."""

    def __init__(self, root: Path):
        self.root = root

    def shared(self, name: str, src: str) -> None:
        d = self.root / "_shared"
        d.mkdir(exist_ok=True)
        (d / name).write_text(src)

    def function(self, name: str, src: str) -> None:
        d = self.root / name
        d.mkdir(exist_ok=True)
        (d / "index.ts").write_text(src)

    def requirements(self, name: str) -> dict:
        return fs.requirements_for(name, str(self.root))


class FunctionSecretsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tree = Tree(Path(self._tmp.name))
        fs._MODULE_CACHE.clear()

    def tearDown(self):
        fs._MODULE_CACHE.clear()
        self._tmp.cleanup()

    # --- reading a var directly ---------------------------------------------

    def test_empty_string_fallback_means_required(self):
        self.tree.function("f", 'const K = Deno.env.get("MY_KEY") ?? "";')
        self.assertEqual(self.tree.requirements("f")["required"], ["MY_KEY"])

    def test_a_real_default_means_optional(self):
        self.tree.function("f", 'const M = Deno.env.get("MY_MODEL") ?? "sonnet";')
        r = self.tree.requirements("f")
        self.assertEqual(r["required"], [])
        self.assertEqual(r["optional"], ["MY_MODEL"])

    def test_no_fallback_at_all_means_required(self):
        self.tree.function("f", 'const K = Deno.env.get("MY_KEY");')
        self.assertEqual(self.tree.requirements("f")["required"], ["MY_KEY"])

    def test_a_multiline_binding_is_still_found(self):
        self.tree.function(
            "f", 'const LONG_NAME =\n  Deno.env.get("MY_KEY") ?? "";',
        )
        self.assertEqual(self.tree.requirements("f")["required"], ["MY_KEY"])

    def test_platform_provided_vars_are_never_required(self):
        self.tree.function(
            "f",
            'const U = Deno.env.get("SUPABASE_URL") ?? "";\n'
            'const S = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";\n'
            'const A = Deno.env.get("SUPABASE_ANON_KEY") ?? "";',
        )
        r = self.tree.requirements("f")
        self.assertEqual(r["required"], [])
        self.assertEqual(r["optional"], [])

    def test_a_commented_out_read_does_not_count(self):
        self.tree.function(
            "f", '// const K = Deno.env.get("MY_KEY") ?? "";\nconst x = 1;',
        )
        self.assertEqual(self.tree.requirements("f")["required"], [])

    # --- the guard demotion --------------------------------------------------

    def test_a_truthiness_guard_demotes_a_var_to_optional(self):
        """The `ask` pattern: feature-detect, degrade, do not break."""
        self.tree.shared(
            "openai.ts",
            'export const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";\n'
            "export function requireOpenAI() { if (!OPENAI_API_KEY) throw 1; }\n"
            "export function embed() { const k = requireOpenAI(); return k; }",
        )
        self.tree.function(
            "f",
            'import { embed } from "../_shared/openai.ts";\n'
            'if (Deno.env.get("OPENAI_API_KEY")) { embed(); }',
        )
        r = self.tree.requirements("f")
        self.assertEqual(r["required"], [])
        self.assertIn("OPENAI_API_KEY", r["optional"])

    # --- reachability through a shared module -------------------------------

    def _openai_module(self):
        self.tree.shared(
            "openai.ts",
            'export const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";\n'
            "export function requireOpenAI(): string {\n"
            '  if (!OPENAI_API_KEY) throw new Error("no key");\n'
            "  return OPENAI_API_KEY;\n"
            "}\n"
            "export function chatJson() { const k = requireOpenAI(); return k; }\n"
            "export function corsHeaders() { return {}; }\n"
            "export function jsonResponse() { return new Response(); }\n",
        )

    def test_importing_a_gated_helper_requires_the_secret(self):
        self._openai_module()
        self.tree.function(
            "f", 'import { chatJson } from "../_shared/openai.ts";\nchatJson();',
        )
        self.assertEqual(self.tree.requirements("f")["required"], ["OPENAI_API_KEY"])

    def test_importing_an_ungated_helper_requires_nothing(self):
        """The precision that matters: jsonResponse is not an OpenAI call.

        Treating any import from openai.ts as needing an OpenAI key would tell
        an owner that send-push and vault-config need one. They do not, and a
        check that cries wolf gets ignored.
        """
        self._openai_module()
        self.tree.function(
            "f",
            'import { corsHeaders, jsonResponse } from "../_shared/openai.ts";\n'
            "corsHeaders(); jsonResponse();",
        )
        self.assertEqual(self.tree.requirements("f")["required"], [])

    def test_reachability_follows_more_than_one_hop(self):
        """chatJson -> requireOpenAI -> OPENAI_API_KEY is two hops."""
        self._openai_module()
        self.tree.shared(
            "wrapper.ts",
            'import { chatJson } from "./openai.ts";\n'
            "export function outer() { return chatJson(); }\n",
        )
        self.tree.function(
            "f", 'import { outer } from "../_shared/wrapper.ts";\nouter();',
        )
        self.assertEqual(self.tree.requirements("f")["required"], ["OPENAI_API_KEY"])

    def test_importing_the_constant_itself_requires_it(self):
        self._openai_module()
        self.tree.function(
            "f",
            'import { OPENAI_API_KEY } from "../_shared/openai.ts";\n'
            "console.log(OPENAI_API_KEY.length);",
        )
        self.assertEqual(self.tree.requirements("f")["required"], ["OPENAI_API_KEY"])

    def test_remote_imports_are_ignored(self):
        self.tree.function(
            "f",
            'import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";\n'
            'import webpush from "npm:web-push@3.6.7";\n',
        )
        self.assertEqual(self.tree.requirements("f")["required"], [])

    # --- discovery ----------------------------------------------------------

    def test_shared_is_not_treated_as_a_deployable_function(self):
        self._openai_module()
        self.tree.function("real", "const x = 1;")
        self.assertEqual(fs.function_names(str(self.tree.root)), ["real"])

    def test_a_directory_with_no_index_is_not_a_function(self):
        (self.tree.root / "notafunction").mkdir()
        self.tree.function("real", "const x = 1;")
        self.assertEqual(fs.function_names(str(self.tree.root)), ["real"])

    # --- helpers used by the shell wrapper ----------------------------------

    def test_needing_lists_every_function_that_requires_a_var(self):
        reqs = {
            "a": {"required": ["K"], "optional": []},
            "b": {"required": ["K", "J"], "optional": []},
            "c": {"required": [], "optional": ["K"]},
        }
        self.assertEqual(fs.needing(reqs, "K"), ["a", "b"])
        self.assertEqual(fs.needing(reqs, "J"), ["b"])

    def test_required_union_is_sorted_and_deduplicated(self):
        reqs = {
            "a": {"required": ["K", "J"], "optional": []},
            "b": {"required": ["J"], "optional": []},
        }
        self.assertEqual(fs.required_union(reqs), ["J", "K"])

    # --- against the real functions in this repo ----------------------------

    def test_every_real_function_is_covered(self):
        names = fs.function_names()
        self.assertEqual(len(names), 11)
        self.assertIn("ask", names)
        # Creates accounts on the service-role key, and needs no secret of its
        # own: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are platform-provided.
        self.assertIn("approve-access-request", names)
        self.assertNotIn("_shared", names)

    def test_ask_needs_anthropic_and_treats_openai_as_optional(self):
        r = fs.requirements_for("ask")
        self.assertIn("ANTHROPIC_API_KEY", r["required"])
        # ask guards its RAG step on the key and answers from live data without
        # it, so a missing OpenAI key degrades Ask Infinity rather than breaking it.
        self.assertNotIn("OPENAI_API_KEY", r["required"])
        self.assertIn("OPENAI_API_KEY", r["optional"])

    def test_send_push_needs_the_vapid_pair_and_no_ai_key(self):
        r = fs.requirements_for("send-push")
        self.assertEqual(
            r["required"], ["VAPID_PRIVATE_KEY", "VAPID_PUBLIC_KEY"],
        )
        self.assertIn("VAPID_SUBJECT", r["optional"])

    def test_extract_specs_needs_anthropic_but_not_openai(self):
        """It imports only corsHeaders/jsonResponse from the OpenAI module."""
        r = fs.requirements_for("extract-specs")
        self.assertEqual(r["required"], ["ANTHROPIC_API_KEY"])

    def test_vault_config_needs_no_secret_of_its_own(self):
        self.assertEqual(fs.requirements_for("vault-config")["required"], [])

    def test_transcribe_needs_openai_for_whisper(self):
        self.assertEqual(
            fs.requirements_for("transcribe-install-memo")["required"],
            ["OPENAI_API_KEY"],
        )

    def test_the_repo_wide_required_set_is_exactly_these_four(self):
        """A change here should be a deliberate one, so pin the whole set."""
        self.assertEqual(
            fs.required_union(fs.all_requirements()),
            [
                "ANTHROPIC_API_KEY",
                "OPENAI_API_KEY",
                "VAPID_PRIVATE_KEY",
                "VAPID_PUBLIC_KEY",
            ],
        )

    def test_no_platform_var_leaks_into_the_required_set(self):
        for name, r in fs.all_requirements().items():
            for var in r["required"]:
                self.assertNotIn(var, fs.PLATFORM_PROVIDED, "%s: %s" % (name, var))

    def test_the_report_names_the_functions_behind_each_secret(self):
        text = fs.render(fs.all_requirements())
        self.assertIn("ANTHROPIC_API_KEY", text)
        self.assertIn("ask", text)
        self.assertIn("send-push", text)


class PlainEnglishNames(unittest.TestCase):
    """The failure message is read by someone who is not an engineer.

    A label is the only part of this tool that cannot be derived from source, so it
    is the only part that can rot. These tests are the thing that stops it: adding
    a function without a label fails CI instead of shipping a message that tells
    the owner "extract-specs is broken", which is not English.
    """

    def test_every_function_has_a_plain_english_name(self):
        for name in fs.function_names():
            self.assertIn(
                name,
                fs.FEATURE_NAMES,
                "add %r to FEATURE_NAMES in scripts/function_secrets.py so the "
                "failure message can name it in English" % name,
            )

    def test_no_label_names_a_function_that_no_longer_exists(self):
        existing = set(fs.function_names())
        for name in fs.FEATURE_NAMES:
            self.assertIn(name, existing, "%s was deleted; drop its label" % name)

    def test_labels_stay_short_enough_for_a_one_line_headline(self):
        for name, label in fs.FEATURE_NAMES.items():
            self.assertLessEqual(len(label), 40, "%s: %r is too long" % (name, label))

    def test_no_label_contains_the_list_separator(self):
        """features_needing joins on '|', so a label containing one would split."""
        for name, label in fs.FEATURE_NAMES.items():
            self.assertNotIn("|", label, name)

    def test_no_label_is_just_the_directory_name(self):
        for name, label in fs.FEATURE_NAMES.items():
            self.assertNotEqual(name, label, "%s needs a real English name" % name)

    def test_the_anthropic_headline_names_both_features(self):
        """The exact case that will be red on the first real run."""
        got = fs.features_needing(fs.all_requirements(), "ANTHROPIC_API_KEY")
        self.assertEqual(got, "Ask Infinity|plan-set reading")

    def test_an_unknown_function_falls_back_to_its_directory_name(self):
        self.assertEqual(fs.feature_name("not-a-function"), "not-a-function")


if __name__ == "__main__":
    unittest.main(verbosity=2)

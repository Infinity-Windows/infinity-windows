#!/usr/bin/env python3
"""Work out which Supabase secret each edge function needs at runtime.

Why this exists: a function's runtime secrets live in the Supabase project, not
in GitHub. Deploying `ask` without `ANTHROPIC_API_KEY` set gives you a function
that is live, routes correctly, passes scripts/verify-functions.sh, shows green
on every CI check — and returns 500 the first time an installer taps Ask
Infinity. Every check in this repo can pass while the feature is completely
broken. That is the exact failure shape this project keeps hitting.

DERIVED, NOT HAND-MAINTAINED. A committed list of "function -> secrets" would be
correct on the day it was written and wrong a month later, the way the README's
list of four deployable functions was wrong once there were ten. So this reads
the sources instead:

  1. In each module, find the constants bound to `Deno.env.get("VAR")`. A `?? ""`
     fallback means the code treats absence as fatal (each shared module has a
     `requireX()` that throws on empty); a real fallback value like
     `?? "claude-sonnet-5"` means it is optional.
  2. Within a module, work out which exported functions can reach those
     constants, following calls between functions in that file. This is what
     makes the answer precise: `chatJson` reaches `requireOpenAI` reaches
     `OPENAI_API_KEY`, while `corsHeaders` and `jsonResponse` reach nothing. So
     importing `jsonResponse` does NOT mean a function needs an OpenAI key.
  3. A function directory needs VAR if its index.ts imports something that
     reaches VAR, or reads VAR itself at module scope.
  4. An explicit `if (Deno.env.get("VAR"))` guard DEMOTES VAR to optional for
     that function: the author is feature-detecting, so absence degrades instead
     of breaking. `ask` does this for OPENAI_API_KEY — its RAG step is optional
     and it answers from live data without it.

Usage:
    scripts/function_secrets.py            # readable per-function report
    scripts/function_secrets.py --names    # required secret names, one per line
    scripts/function_secrets.py --users    # VAR<tab>funcs<tab>feature|feature
    scripts/function_secrets.py --json     # machine-readable

Normally invoked through scripts/verify-function-secrets.sh, which compares this
with `supabase secrets list`.
"""

from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FUNCTIONS_DIR = os.path.join(HERE, '..', 'supabase', 'functions')

# Injected into every edge function by the Supabase platform itself. They show
# up in `supabase secrets list` without anyone setting them, and telling an owner
# to set SUPABASE_URL by hand would be wrong as well as confusing.
# https://supabase.com/docs/guides/functions/secrets
PLATFORM_PROVIDED = frozenset({
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_DB_URL',
    'SUPABASE_PUBLISHABLE_KEY',
})

# What each function IS, for whoever reads the failure. The person who has to act
# on "ANTHROPIC_API_KEY is missing" is the owner, who is not an engineer: `ask`
# means nothing to him, "Ask Infinity" is the button he has tapped.
#
# This is presentation only — it never affects whether a secret is judged
# required, so a wrong or missing label cannot produce a wrong verdict. It is the
# one thing here that cannot be derived from source, since no amount of reading
# index.ts yields the words "Ask Infinity". test_function_secrets.py asserts every
# function has an entry, so adding a function without one fails CI rather than
# quietly falling back to the directory name.
#
# Keep them short. They get assembled into a one-line headline that goes to Slack
# and into a GitHub error annotation, and a label that reads like a sentence makes
# that line unreadable.
FEATURE_NAMES = {
    'approve-access-request': 'letting a new crew member in',
    'ask': 'Ask Infinity',
    'extract-schedule': 'reading delivery schedules',
    'extract-specs': 'plan-set reading',
    'generate-howto': 'how-to guides',
    'generate-toolbox-talk': 'toolbox talks',
    'ingest-knowledge': 'adding documents to the brain',
    'send-push': 'push notifications',
    'synthesize-type-tips': 'window-type tips',
    'transcribe-install-memo': 'install voice memos',
    'vault-config': 'the vault PIN screen',
}


def feature_name(function: str) -> str:
    """Plain-English name for a function, falling back to its directory name."""
    return FEATURE_NAMES.get(function, function)


def features_needing(reqs: dict, var: str) -> str:
    """Pipe-separated feature labels, e.g. 'Ask Infinity|plan-set reading'.

    Pipe rather than comma because the labels are reassembled into a list by the
    caller, and a comma-separated string cannot be split back apart safely the
    moment one label contains a comma.
    """
    return '|'.join(feature_name(n) for n in needing(reqs, var))


def strip_comments(src: str) -> str:
    """Remove // and /* */ comments so a commented-out read is not counted."""
    src = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    return re.sub(r'(?<!:)//[^\n]*', '', src)


# `const NAME = Deno.env.get("VAR") ?? <default>`, with the value possibly on
# the next line, and the `?? default` possibly absent.
ENV_CONST_RE = re.compile(
    r'(?:export\s+)?const\s+(\w+)\s*(?::\s*[\w<>\[\]|]+\s*)?=\s*'
    r'Deno\.env\.get\(\s*["\']([A-Z0-9_]+)["\']\s*\)'
    r'(?:\s*\?\?\s*(?P<default>"[^"]*"|\'[^\']*\'|`[^`]*`))?',
    re.S,
)

# A bare read used as a truthiness test: the author is feature-detecting.
GUARD_RE = re.compile(
    r'if\s*\(\s*Deno\.env\.get\(\s*["\']([A-Z0-9_]+)["\']\s*\)\s*\)',
)

# Any read at all, for reporting vars that are read but neither bound nor guarded.
ANY_READ_RE = re.compile(r'Deno\.env\.get\(\s*["\']([A-Z0-9_]+)["\']\s*\)')

FUNC_DEF_RE = re.compile(
    r'(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(',
)

IMPORT_RE = re.compile(
    r'import\s+(?:type\s+)?\{(?P<names>[^}]*)\}\s*from\s*["\'](?P<path>[^"\']+)["\']',
    re.S,
)


def match_braces(src: str, start: int):
    """Body of the block whose opening brace is at or after `start`."""
    i = src.find('{', start)
    if i < 0:
        return ''
    depth = 0
    j = i
    while j < len(src):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                return src[i + 1:j]
        j += 1
    return src[i:]


class Module:
    """One TypeScript file's env reads and which of its functions reach them."""

    def __init__(self, path: str):
        self.path = path
        with open(path) as fh:
            self.src = strip_comments(fh.read())

        # const binding name -> (VAR, required?)
        self.bindings: dict[str, tuple[str, bool]] = {}
        for m in ENV_CONST_RE.finditer(self.src):
            binding, var = m.group(1), m.group(2)
            default = m.group('default')
            # No fallback, or a fallback of "" — the code cannot work without it.
            required = default is None or default[1:-1] == ''
            self.bindings[binding] = (var, required)

        self.guarded = set(GUARD_RE.findall(self.src))
        self.functions = self._function_bodies()
        self.reaches = self._resolve_reachability()

    def _function_bodies(self) -> dict[str, str]:
        out = {}
        for m in FUNC_DEF_RE.finditer(self.src):
            out[m.group(1)] = match_braces(self.src, m.end())
        return out

    def _resolve_reachability(self) -> dict[str, set[str]]:
        """Which env VARs each function in this file can reach.

        Direct references first, then propagate across calls between functions
        in the same file until nothing changes. One pass is not enough:
        `chatJson` -> `requireOpenAI` -> `OPENAI_API_KEY` is two hops.
        """
        direct: dict[str, set[str]] = {}
        calls: dict[str, set[str]] = {}
        for name, body in self.functions.items():
            words = set(re.findall(r'\b\w+\b', body))
            direct[name] = {
                self.bindings[w][0] for w in words if w in self.bindings
            }
            calls[name] = {w for w in words if w in self.functions and w != name}

        reaches = {n: set(v) for n, v in direct.items()}
        changed = True
        while changed:
            changed = False
            for name in reaches:
                grown = set(reaches[name])
                for callee in calls[name]:
                    grown |= reaches[callee]
                if grown != reaches[name]:
                    reaches[name] = grown
                    changed = True
        return reaches

    def required_vars(self) -> set[str]:
        return {var for var, req in self.bindings.values() if req}

    def vars_for_export(self, name: str) -> set[str]:
        """Env VARs an importer of `name` becomes dependent on."""
        if name in self.reaches:
            return set(self.reaches[name])
        if name in self.bindings:
            return {self.bindings[name][0]}
        return set()


_MODULE_CACHE: dict[str, Module] = {}


def load_module(path: str) -> Module | None:
    real = os.path.normpath(path)
    if real not in _MODULE_CACHE:
        if not os.path.isfile(real):
            return None
        _MODULE_CACHE[real] = Module(real)
    return _MODULE_CACHE[real]


def function_names(functions_dir: str = FUNCTIONS_DIR) -> list[str]:
    """Deployable function directories. `_shared` is helpers, not a function."""
    if not os.path.isdir(functions_dir):
        return []
    return sorted(
        name for name in os.listdir(functions_dir)
        if not name.startswith('_')
        and os.path.isfile(os.path.join(functions_dir, name, 'index.ts'))
    )


def requirements_for(name: str, functions_dir: str = FUNCTIONS_DIR) -> dict:
    """{'required': [...], 'optional': [...]} for one function directory."""
    entry = os.path.join(functions_dir, name, 'index.ts')
    own = load_module(entry)
    if own is None:
        return {'required': [], 'optional': []}

    required: set[str] = set()
    optional: set[str] = set()

    # Vars the function's own file binds at module scope.
    for var, req in own.bindings.values():
        (required if req else optional).add(var)

    # Vars reached through what it imports from local modules.
    seen: set[str] = set()
    for var in _imported_vars(entry, own, seen):
        required.add(var)

    # Anything read but never bound or reached is at least worth listing.
    for var in ANY_READ_RE.findall(own.src):
        if var not in required:
            optional.add(var)

    # A truthiness guard means the code copes without it.
    for var in own.guarded:
        required.discard(var)
        optional.add(var)

    required -= PLATFORM_PROVIDED
    optional -= PLATFORM_PROVIDED | required
    return {'required': sorted(required), 'optional': sorted(optional)}


def _imported_vars(entry: str, module: Module, seen: set[str]) -> set[str]:
    """Required VARs reachable through `module`'s local imports, recursively."""
    if entry in seen:
        return set()
    seen.add(entry)

    out: set[str] = set()
    base = os.path.dirname(entry)
    for m in IMPORT_RE.finditer(module.src):
        path = m.group('path')
        # Only local files; https:// and npm: imports have no env of ours.
        if not path.startswith('.'):
            continue
        target = os.path.normpath(os.path.join(base, path))
        dep = load_module(target)
        if dep is None:
            continue
        names = [
            n.split(' as ')[0].strip().replace('type ', '').strip()
            for n in m.group('names').split(',')
        ]
        for name in names:
            if not name:
                continue
            for var in dep.vars_for_export(name):
                if var in dep.required_vars():
                    out.add(var)
        out |= _imported_vars(target, dep, seen)
    return out


def all_requirements(functions_dir: str = FUNCTIONS_DIR) -> dict:
    return {
        name: requirements_for(name, functions_dir)
        for name in function_names(functions_dir)
    }


def required_union(reqs: dict) -> list[str]:
    out: set[str] = set()
    for r in reqs.values():
        out |= set(r['required'])
    return sorted(out)


def needing(reqs: dict, var: str) -> list[str]:
    return sorted(n for n, r in reqs.items() if var in r['required'])


def render(reqs: dict) -> str:
    lines = []
    width = max([len(n) for n in reqs] or [10])
    for name in sorted(reqs):
        r = reqs[name]
        need = ', '.join(r['required']) or '(none)'
        lines.append('  %-*s  %s' % (width, name, need))
        if r['optional']:
            lines.append('  %-*s  optional: %s' % (width, '', ', '.join(r['optional'])))
    lines.append('')
    lines.append('Secrets that must exist in the Supabase project:')
    for var in required_union(reqs):
        lines.append('  %-24s used by %s' % (var, ', '.join(needing(reqs, var))))
    return '\n'.join(lines) + '\n'


def main(argv):
    reqs = all_requirements()
    if '--json' in argv:
        sys.stdout.write(json.dumps(reqs, indent=2, sort_keys=True) + '\n')
    elif '--names' in argv:
        sys.stdout.write('\n'.join(required_union(reqs)) + '\n')
    elif '--users' in argv:
        # VAR <tab> function,function <tab> feature label|feature label
        for var in required_union(reqs):
            sys.stdout.write('%s\t%s\t%s\n' % (
                var, ','.join(needing(reqs, var)), features_needing(reqs, var),
            ))
    else:
        sys.stdout.write(render(reqs))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))

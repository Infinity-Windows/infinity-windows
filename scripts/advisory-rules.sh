#!/usr/bin/env bash
# The house rules that a machine can check exactly, run over one pull request.
#
# WHY THIS EXISTS. CLAUDE.md holds about a dozen laws that were each written
# after something went wrong — an installer shown a raw Postgres constraint
# name, a table shipped without row security, two migrations at one version
# number of which `supabase db push` silently applied only the first. Every one
# of them has been broken again at least once by somebody who had not read that
# paragraph yet. A law nothing checks is a law that holds only while the person
# who wrote it is in the room.
#
# WHAT BELONGS HERE, AND WHAT DOES NOT. Only rules that are EXACT: same commit,
# same answer, on any machine, with no model and no network. That is what lets
# this half FAIL a pull request, and what would let the owner mark it required
# in branch protection. Anything needing judgement — does this Spanish say what
# the English says, would an installer know what to do about this error — is
# the other half's job: .checks/*.md, run by scripts/advisory-agent.sh, which
# never fails anything.
#
# IT READS THE LINES THE PULL REQUEST ADDS, not the files it touches. Fixing a
# typo in a file that has held an old `String(err)` since March must not turn
# that pull request red: the finding would be about somebody else's line, and a
# check that punishes people for opening the wrong file gets switched off. The
# exception is the migration rules, which read a NEW migration whole — a
# table's row security is turned on ten lines below the `create table`, so the
# question is about the file, not about a line.
#
# Usage:
#   scripts/advisory-rules.sh                        # against origin/master
#   scripts/advisory-rules.sh --base <ref> --head <ref>
#
# Env (for the tests, and for the workflow):
#   ADVISORY_REPO   repository to work in (default: this repo)
#   ADVISORY_BASE   base ref (default: merge-base with origin/master)
#   ADVISORY_HEAD   head ref (default: HEAD)
#   GH_BIN          the gh binary, for the open-branch half of the version rule
#
# Exit status: 0 when nothing was found, 1 when something was, 2 on misuse.
set -uo pipefail

REPO="${ADVISORY_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
BASE="${ADVISORY_BASE:-}"
HEAD_REF="${ADVISORY_HEAD:-HEAD}"
GH_BIN="${GH_BIN:-gh}"
AWK_SQL="$(cd "$(dirname "$0")" && pwd)/lib/advisory-sql.awk"

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --head) HEAD_REF="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,39p' "$0"; exit 0 ;;
    *) echo "advisory-rules: unknown argument $1" >&2; exit 2 ;;
  esac
done

cd "$REPO" || { echo "advisory-rules: no such repository $REPO" >&2; exit 2; }

if [ -z "$BASE" ]; then
  BASE="$(git merge-base origin/master "$HEAD_REF" 2>/dev/null)" || BASE=""
  [ -n "$BASE" ] || BASE="origin/master"
fi

hits=0
notes=0

# A name a `sed` substitution pulled out of a statement, or nothing.
#
# WHY THIS IS A FUNCTION AND NOT AN `if`. `sed s/pattern/\2/` returns its INPUT
# unchanged when the pattern does not match, which for these rules means
# `$short` silently becomes the whole statement text — and that text was then
# spliced raw into three `grep -E` patterns. A table written
# `create table "Audit Log" (...)` produced three findings whose wording was
# the statement quoting itself, on a check that can block a merge, and the
# parentheses in it made the pattern an invalid regular expression as well.
# A name this cannot read is UNMEASURED, which is a note, never a finding.
plain_name() { # candidate
  case "$1" in
    ""|*[!a-z0-9_.]*) return 1 ;;
  esac
  return 0
}

# One finding. `where` is file:line — or a commit sha for the subject rule, the
# only law here that is not about a place in a file.
report() {
  hits=$((hits + 1))
  printf '%s  [%s]  %s\n' "$1" "$2" "$3"
  printf '      law: %s\n' "$4"
}

# Something the check could not measure. Never a failure: a rule that goes red
# because a tool was missing teaches people that red means nothing.
note() {
  notes=$((notes + 1))
  printf 'note: %s\n' "$1"
}

# The lines this pull request ADDS to one file, as `lineno<TAB>text`.
added_lines() {
  git diff -U0 "$BASE" "$HEAD_REF" -- "$1" | awk '
    /^\+\+\+/ { next }
    /^@@/ {
      # @@ -old,count +new,count @@ — the first +number is the new-file start.
      if (match($0, /\+[0-9]+/)) n = substr($0, RSTART + 1, RLENGTH - 1)
      next
    }
    /^\+/ { print n "\t" substr($0, 2); n++ }
  '
}

# The file as the pull request leaves it, for the rules that have to look at
# the lines around an added one.
file_at_head() { git show "$HEAD_REF:$1" 2>/dev/null; }

# True when a line within `radius` of `line` matches the regex.
near() { # file line radius regex
  local from=$(( $2 - $3 ))
  [ "$from" -lt 1 ] && from=1
  file_at_head "$1" | sed -n "${from},$(( $2 + $3 ))p" | grep -qE "$4"
}

changed_files="$(git diff --name-only --diff-filter=d "$BASE" "$HEAD_REF" 2>/dev/null)"
new_files="$(git diff --name-only --diff-filter=A "$BASE" "$HEAD_REF" 2>/dev/null)"

# ---------------------------------------------------------------------------
# The app rules, over added lines
# ---------------------------------------------------------------------------
LAW_ERR='CLAUDE.md, Things that will trip you up — "Never render an error with String(err)": PostgrestError stringifies to raw Postgres text and leaks constraint names to installers. Always formatApiError(err).'
LAW_PROFILES='CLAUDE.md, Things that will trip you up — profiles holds pin_hash, which no client role may read, so select("*") against it fails by design. Add the column to PROFILE_COLS, never widen to *.'
LAW_SCHEMA='CLAUDE.md, Things that will trip you up — "Table does not exist yet" checks go through lib/schemaErrors.ts. Seventeen hand-written copies had quietly stopped agreeing about the codes. Use isMissingTable / isMissingColumn / isMissingFunction.'
LAW_PHOTO='app/src/lib/photo/usePhotoPicker.tsx — the ONE place in the app that writes an <input type="file"> for a picture: the camera input always carries capture, the library input never does, and no other file input may offer images.'

# The modules that IMPLEMENT the error rule. A formatter has to touch the raw
# value in order to replace it.
error_rule_exempt() {
  case "$1" in
    app/src/lib/errors.ts|app/src/lib/install/errors.ts|app/src/lib/edgeErrors.ts|app/src/lib/crashReport.ts) return 0 ;;
  esac
  return 1
}

for f in $changed_files; do
  case "$f" in app/src/*.ts|app/src/*.tsx) ;; *) continue ;; esac
  # A test asserts on the very things these rules forbid — it hands a fake
  # PGRST205 to the code under test, and renders the file inputs it is
  # checking. Flagging a test file would mean the rule fires hardest on the
  # people writing the proof that the rule holds. Vendored code is a port kept
  # deliberately diffable (CLAUDE.md, Maps Interactive), so it is not ours to
  # restyle either.
  case "$f" in *.test.ts|*.test.tsx|*/vendor/*) continue ;; esac
  while IFS=$'\t' read -r ln text; do
    [ -n "$ln" ] || continue
    # A line that is only a comment is talking ABOUT a law, not breaking it.
    case "$(printf '%s' "$text" | sed 's/^[[:space:]]*//')" in "//"*|"*"*|"/*"*) continue ;; esac

    if ! error_rule_exempt "$f"; then
      if printf '%s' "$text" | grep -qE 'String\([[:space:]]*(err|error|e|ex|caught|reason)[[:space:]]*\)'; then
        report "$f:$ln" error-string \
          "An error becomes text through String(...), which shows an installer raw Postgres wording. Use formatApiError(err)." "$LAW_ERR"
      fi
    fi

    if printf '%s' "$text" | grep -qE '\.select\((["'"'"'])\*\1\)'; then
      if printf '%s' "$text" | grep -q 'profiles' || near "$f" "$ln" 3 '"profiles"'; then
        report "$f:$ln" profiles-star \
          "select(\"*\") against profiles. It fails by design: pin_hash is readable by no client role." "$LAW_PROFILES"
      fi
    fi

    case "$f" in app/src/lib/schemaErrors.ts) ;; *)
      if printf '%s' "$text" | grep -qE 'PGRST20[245]|42P01|42703|42883|schema cache'; then
        report "$f:$ln" inline-missing-table \
          "A missing table, column or function is recognised by hand here. That check has one home." "$LAW_SCHEMA"
      fi ;;
    esac

    case "$f" in app/src/lib/photo/usePhotoPicker.tsx) ;; *)
      if printf '%s' "$text" | grep -q 'type="file"' && near "$f" "$ln" 6 'accept=.*image|capture='; then
        report "$f:$ln" photo-file-input \
          "A new file input that offers images, outside usePhotoPicker. That is how \"Upload files\" came to mean \"camera only\"." "$LAW_PHOTO"
      fi ;;
    esac
  done < <(added_lines "$f")
done

# ---------------------------------------------------------------------------
# The phrasebook rule: a Spanish line that is the English line
# ---------------------------------------------------------------------------
# Every catalog entry ships in both languages — CatalogEntry requires `es`, so
# an English-only entry will not compile. Nothing stops the Spanish being a
# COPY of the English, which compiles, reads as done in review, and leaves a
# crew member with an English screen. A few entries are identical on purpose
# ("English", "Español", a job code): mark those with i18n-same-on-purpose on
# the entry or on the line above it.
LAW_I18N='app/src/lib/i18n/catalog.ts — "every string ships in English AND Spanish from the start, never English alone". An es that repeats the en is an untranslated string that compiles.'
for f in $changed_files; do
  case "$f" in app/src/lib/i18n/*.ts) ;; *) continue ;; esac
  case "$f" in *.test.ts) continue ;; esac
  added="$(added_lines "$f" | cut -f1 | tr '\n' ' ')"
  [ -n "$added" ] || continue
  while IFS=$'\t' read -r ln key; do
    [ -n "$ln" ] || continue
    report "$f:$ln" spanish-copies-english \
      "\"$key\" ships the English string as its Spanish. Translate it, or mark the entry i18n-same-on-purpose." "$LAW_I18N"
  done < <(file_at_head "$f" | awk -v added=" $added " '
    function value(s,   i, n, c, out, esc) {
      i = index(s, "\"")
      if (i == 0) return "\001"
      n = length(s); out = ""; esc = 0
      for (i = i + 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (esc) { out = out c; esc = 0; continue }
        if (c == "\\") { out = out c; esc = 1; continue }
        if (c == "\"") return out
        out = out c
      }
      return "\001"
    }
    /i18n-same-on-purpose/ { deliberate = NR }
    /^[[:space:]]*"[^"]+":[[:space:]]*\{/ {
      key = $0; sub(/^[[:space:]]*"/, "", key); sub(/".*/, "", key)
      en = ""; es = ""; esline = 0; start = NR
      ok = (deliberate >= NR - 1) ? 0 : 1
    }
    key != "" && /i18n-same-on-purpose/ { ok = 0 }
    key != "" && /[{,][[:space:]]*en:/ { en = value(substr($0, index($0, "en:"))) }
    key != "" && /[{,][[:space:]]*es:/ { es = value(substr($0, index($0, "es:"))); esline = NR }
    key != "" && /\}/ {
      if (ok && en != "" && en != "\001" && en == es) {
        touched = 0
        for (i = start; i <= NR; i++) if (index(added, " " i " ")) touched = 1
        if (touched) print (esline ? esline : start) "\t" key
      }
      key = ""
    }
  ')
done

# ---------------------------------------------------------------------------
# The migration rules, over whole new migration files
# ---------------------------------------------------------------------------
LAW_RLS='THE WALL (supabase/migrations/20260950000000, replayed by scripts/test_partner_wall.py) — a crew-readable table carries row-level security, has its default grants revoked, and names `not public.is_partner_user()` in its policies, or a builder portal login is inside the wall.'
LAW_DEFINER='A SECURITY DEFINER function runs as the owner and ignores row security, so it pins `set search_path` — otherwise a table planted in another schema decides what it reads — and says who may execute it. See supabase/migrations/20260995000000 for the shape.'
LAW_VERSION='supabase/migrations/20260995000000 — "Two files at one version is not a merge conflict: supabase db push reads the version, sees it applied, and skips the second file without a word." Check master AND every open PR branch before picking a number.'

new_migrations=""
for f in $new_files; do
  case "$f" in supabase/migrations/*.sql) new_migrations="$new_migrations $f" ;; esac
done

# The functions master already has, so a REBUILD can be told from a birth.
#
# WHY THIS LIST EXISTS. `create or replace function` keeps the privileges the
# object already carries — a replace changes the body, not the ACL — so a
# migration that rebuilds an existing function has no reason to repeat its
# grant, and demanding one is asking for a line that changes nothing. Without
# this, the rule fired 14 times on 20260986000000_warehouse_is_crew_work.sql
# (#531) and twice on 20260987000000_remove_login_start_fresh.sql (#532), both
# merged and both correct: `pipeline_nudge_audience`, to take one, was granted
# where it was born in 20260979000000_job_pipeline.sql:395.
#
# `set search_path` is NOT inherited the same way — a replace rewrites the
# whole definition, SET clauses included — so that half of the rule still asks
# the question of every definer function, rebuild or not.
master_functions=""
master_functions_readable=0
if [ -n "$new_migrations" ] && git rev-parse --verify -q origin/master >/dev/null 2>&1; then
  master_functions_readable=1
  master_functions="$(git grep -h -oiE 'create (or replace )?function +[a-z0-9_.]+ *\(' \
    origin/master -- 'supabase/migrations/*.sql' 2>/dev/null |
    sed -E 's/^create (or replace )?function +//I; s/ *\($//' |
    tr 'A-Z' 'a-z' | sed 's/^public\.//' | sort -u)"
fi

# True when master already holds a function of this name, so the statement
# under the cursor is a rebuild rather than a birth.
already_on_master() { printf '%s\n' "$master_functions" | grep -qxF "$1"; }

for f in $new_migrations; do
  stmts="$(awk -f "$AWK_SQL" <(file_at_head "$f"))"

  # Every table a migration creates has to arrive with its door shut.
  #
  # THESE FOUR GREPS ARE NOT ANCHORED TO THE START OF A STATEMENT, which they
  # used to be, and the reason is the shape this repo actually writes. Policies
  # here live inside `do $$ begin if not exists (...) then create policy ...`,
  # so the statement the splitter emits BEGINS `do begin if not exists` and the
  # `create policy` is forty characters in. Anchoring on the statement start
  # made the partner-guard rule blind to 46 of the 81 migrations that have ever
  # created a policy, and it went red on two MERGED ones whose policies are
  # correct. Dropping the anchor is safe because the splitter has already
  # removed the two places a false match could hide: `--` and `/* */` comments
  # are gone, and `'...'` literals are blanked.
  while IFS=$'\t' read -r ln stmt; do
    [ -n "$ln" ] || continue
    t="$(printf '%s' "$stmt" | sed -E 's/^create table (if not exists )?([a-z0-9_.]+).*/\2/')"
    short="${t#public.}"
    if ! plain_name "$short"; then
      note "$f:$ln creates a table whose name this cannot read — a quoted identifier, most likely. Its row security, its grants and its partner guard were NOT checked; read them by hand."
      continue
    fi

    printf '%s\n' "$stmts" | grep -qE 'alter table (only )?(public\.)?'"$short"' .*enable row level security' ||
      report "$f:$ln" table-without-rls \
        "New table \`$short\` never says \`alter table $short enable row level security\`, so every login reads every row." "$LAW_RLS"

    printf '%s\n' "$stmts" | grep -qE 'revoke .* on (table )?(public\.)?'"$short"' from' ||
      report "$f:$ln" table-keeps-default-grants \
        "New table \`$short\` never revokes its default grants. Supabase hands anon and authenticated a grant on every new table in public; row security is the second lock, not the first." "$LAW_RLS"

    # A table nothing in a browser may touch is allowed to have no policy —
    # said out loud, by revoking it from authenticated and granting it to
    # nobody. Anything a crew login can reach needs the partner guard.
    if printf '%s\n' "$stmts" | grep -E 'grant .* on (table )?(public\.)?'"$short"' to' | grep -q 'authenticated' ||
       ! printf '%s\n' "$stmts" | grep -E 'revoke .* on (table )?(public\.)?'"$short"' from' | grep -q 'authenticated'; then
      printf '%s\n' "$stmts" | grep -E 'create policy .* on (public\.)?'"$short"'[ (]' | grep -qF 'not public.is_partner_user()' ||
        report "$f:$ln" policy-without-partner-guard \
          "No policy on \`$short\` carries \`not public.is_partner_user()\`, so a builder's portal login is inside the wall." "$LAW_RLS"
    fi
  done < <(printf '%s\n' "$stmts" | grep -E $'\t''create table ')

  # Every SECURITY DEFINER function pins its search path and says who may call
  # it. "Nobody" is a fine answer, said out loud with a revoke.
  while IFS=$'\t' read -r ln stmt; do
    [ -n "$ln" ] || continue
    printf '%s' "$stmt" | grep -q 'security definer' || continue
    sig="$(printf '%s' "$stmt" | sed -E 's/^create (or replace )?function ([a-z0-9_.]+)\(.*/\2/')"
    short="${sig#public.}"
    if ! plain_name "$short"; then
      note "$f:$ln declares a SECURITY DEFINER function whose name this cannot read. Its search path and its grant were NOT checked; read them by hand."
      continue
    fi

    printf '%s' "$stmt" | grep -q 'set search_path' ||
      report "$f:$ln" definer-without-search-path \
        "\`$short\` is SECURITY DEFINER and does not pin \`set search_path\`." "$LAW_DEFINER"

    printf '%s' "$stmt" | grep -q 'returns trigger' && continue

    # A rebuild keeps the grant its first migration set. Only a function being
    # BORN here has to say who may call it.
    if printf '%s' "$stmt" | grep -q '^create or replace function '; then
      if [ "$master_functions_readable" = 0 ]; then
        note "origin/master could not be read, so \`$short\` was not checked for who may execute it: a \`create or replace\` of a function granted elsewhere inherits that grant, and this cannot tell the two apart."
        continue
      fi
      already_on_master "$short" && continue
    fi

    if ! printf '%s\n' "$stmts" | grep -E 'grant execute on function (public\.)?'"$short"'\(' | grep -q 'authenticated'; then
      printf '%s\n' "$stmts" | grep -E 'revoke .* on function (public\.)?'"$short"'\(' | grep -q 'authenticated' ||
        report "$f:$ln" definer-without-grant \
          "\`$short\` is SECURITY DEFINER and the migration never says who may execute it — neither a grant to authenticated nor a revoke from it." "$LAW_DEFINER"
    fi
  done < <(printf '%s\n' "$stmts" | grep -E $'\t''create (or replace )?function ')
done

# ---------------------------------------------------------------------------
# The migration version rule — the collision that happened on 2026-09-06
# ---------------------------------------------------------------------------
if [ -n "$new_migrations" ]; then
  master_paths="$(git ls-tree -r --name-only origin/master supabase/migrations 2>/dev/null)"
  master_versions="$(printf '%s\n' "$master_paths" |
    sed -n 's#^supabase/migrations/\([0-9]\{14\}\)_.*#\1#p' | sort)"
  newest_on_master="$(printf '%s\n' "$master_versions" | tail -1)"

  # A version that master holds under THIS FILE'S OWN NAME is not a collision:
  # it is this pull request, already merged, being looked at again. Only the
  # same number under a DIFFERENT filename is the silent-skip shape.
  version_taken_elsewhere() { # version path
    printf '%s\n' "$master_paths" |
      grep -E "^supabase/migrations/$1_" | grep -qvxF "$2"
  }
  on_master_already() { printf '%s\n' "$master_paths" | grep -qxF "$1"; }

  # And every other open pull request's branch, so a number two branches both
  # chose is caught while both are open rather than after the second merge.
  other_versions=""
  if command -v "$GH_BIN" >/dev/null 2>&1; then
    branches="$("$GH_BIN" pr list --state open --json headRefName --jq '.[].headRefName' 2>/dev/null)"
    if [ -n "$branches" ]; then
      for b in $branches; do
        git rev-parse --verify -q "origin/$b" >/dev/null 2>&1 || continue
        git merge-base --is-ancestor "origin/$b" "$HEAD_REF" 2>/dev/null && continue
        for p in $(git ls-tree -r --name-only "origin/$b" supabase/migrations 2>/dev/null); do
          v="$(printf '%s' "$p" | sed -n 's#^supabase/migrations/\([0-9]\{14\}\)_.*#\1#p')"
          [ -n "$v" ] || continue
          printf '%s\n' "$master_versions" | grep -qx "$v" && continue
          other_versions="$other_versions $v:$b:$p"
        done
      done
    else
      note "no open pull request branches were listed, so a number another open branch has already claimed was not checked."
    fi
  else
    note "gh is not on the PATH here, so the open-branch half of the migration-version rule did not run. Master was still checked."
  fi

  for f in $new_migrations; do
    v="$(printf '%s' "$f" | sed -n 's#^supabase/migrations/\([0-9]\{14\}\)_.*#\1#p')"
    if [ -z "$v" ]; then
      report "$f:1" migration-version-shape \
        "A migration filename starts with a 14-digit version. This one does not, so nothing can order it." "$LAW_VERSION"
      continue
    fi
    on_master_already "$f" && continue
    if version_taken_elsewhere "$v" "$f"; then
      report "$f:1" migration-version-taken \
        "Version $v is already on master under another filename. \`supabase db push\` would see it applied and skip this file without a word." "$LAW_VERSION"
    elif [ -n "$newest_on_master" ] && [ "$v" \< "$newest_on_master" ]; then
      report "$f:1" migration-version-behind \
        "Version $v sorts below master's newest ($newest_on_master), so it lands out of order or not at all." "$LAW_VERSION"
    fi
    for triple in $other_versions; do
      [ "${triple%%:*}" = "$v" ] || continue
      rest="${triple#*:}"
      branch="${rest%%:*}"
      # The same number under the same filename on another branch is the same
      # file, travelling; only a different filename is two migrations at one
      # version, of which the database applies one.
      [ "${rest#*:}" = "$f" ] && continue
      report "$f:1" migration-version-claimed \
        "Version $v is also claimed by the open branch $branch. Whichever merges second is skipped in silence." "$LAW_VERSION"
    done
  done
fi

# ---------------------------------------------------------------------------
# Commit subjects
# ---------------------------------------------------------------------------
LAW_SUBJECT='CLAUDE.md, House style — "Commit subjects are one plain sentence about the effect on a person, e.g. Stop windows showing as being installed for days on end. Not conventional commits."'
while read -r sha subject; do
  [ -n "$sha" ] || continue
  printf '%s' "$subject" |
    grep -qE '^(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]*\))?!?:' &&
    report "$sha" commit-subject-conventional \
      "\"$subject\" is a conventional-commit subject. These become the changelog people who install windows read." "$LAW_SUBJECT"
done <<EOF
$(git log --format='%h %s' "$BASE".."$HEAD_REF" 2>/dev/null)
EOF

# ---------------------------------------------------------------------------
echo
changed_count="$(printf '%s\n' "$changed_files" | grep -c .)"
if [ "$hits" -eq 0 ]; then
  echo "House rules: nothing to report across $changed_count changed file(s), $notes note(s)."
  exit 0
fi
echo "House rules: $hits to fix across $changed_count changed file(s), $notes note(s). Each one is exact — the same commit gives the same answer."
exit 1

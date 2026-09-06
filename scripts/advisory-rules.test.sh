#!/usr/bin/env bash
# Tests for scripts/advisory-rules.sh.
#
# Every case builds a throwaway git repository in a temp directory, commits a
# "before" and an "after", and runs the rules across that pair. Nothing here
# touches this repo, the network, gh, or a database — where a case needs gh, it
# gets a stub on the PATH.
#
# WHAT IS WORTH PINNING DOWN, and why each case is here:
#
#   * every rule can FAIL. A check nobody has seen go red is not a check.
#   * every rule can PASS on the shape the house actually writes, taken from
#     real files in this repo. A rule that fires on correct code is worse than
#     no rule: it gets switched off, and takes the other eight with it.
#   * the rules read ADDED LINES. A pull request that opens a file holding an
#     old violation must stay green, or people learn to avoid the file.
#   * a missing gh is a NOTE, not a failure. Half a check is not a red build.
#
#   scripts/advisory-rules.test.sh
#   scripts/advisory-rules.test.sh -v
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
SCRIPT="$PWD/scripts/advisory-rules.sh"
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

passed=0
failed=0
current=""
root=""
OUT=""
RC=0

new_case() {
  current="$1"
  root="$(mktemp -d)"
  mkdir -p "$root/bin" "$root/app/src/pages" "$root/app/src/lib/i18n" \
    "$root/app/src/lib/photo" "$root/supabase/migrations"
  git -C "$root" init -q -b master
  git -C "$root" config user.email "test@example.com"
  git -C "$root" config user.name "Advisory Rules Test"
  git -C "$root" config commit.gpgsign false
  # Something to commit, so a case whose "before" is an empty tree still has a
  # base commit for the diff to be taken against.
  echo "A throwaway repository for one test case." >"$root/README.md"
}

# Commit whatever is in the tree and make origin/master point at it. This is
# the "before" — what the pull request will be measured against.
base_commit() {
  git -C "$root" add -A
  git -C "$root" commit -q -m "${1:-Set up what was already here}"
  git -C "$root" update-ref refs/remotes/origin/master "$(git -C "$root" rev-parse HEAD)"
}

# Commit the tree as the pull request's head.
head_commit() {
  git -C "$root" add -A
  git -C "$root" commit -q -m "${1:-Change something a person would notice}"
}

# A gh that answers `pr list` with the branch names it is given.
stub_gh() {
  {
    echo '#!/usr/bin/env bash'
    echo 'if [ "${1:-}" = "pr" ]; then'
    printf '  printf "%%s\\n" %s\n' "$(printf '%q' "$(printf '%s\n' "$@")")"
    echo '  exit 0'
    echo 'fi'
    echo 'exit 1'
  } >"$root/bin/gh"
  chmod +x "$root/bin/gh"
}

run() {
  OUT="$(env PATH="$root/bin:$PATH" \
    GH_BIN="${GH_BIN_OVERRIDE:-gh-not-installed-anywhere}" \
    ADVISORY_REPO="$root" \
    ADVISORY_BASE="${BASE_OVERRIDE:-origin/master}" \
    ADVISORY_HEAD="${HEAD_OVERRIDE:-HEAD}" \
    bash "$SCRIPT" 2>&1)"
  RC=$?
  if [ "$VERBOSE" = 1 ]; then
    echo "--- $current (rc=$RC)"
    echo "$OUT"
  fi
}

ok() { passed=$((passed + 1)); }

bad() {
  failed=$((failed + 1))
  echo "FAIL: $current"
  echo "      $1"
}

assert_rc() {
  if [ "$RC" = "$1" ]; then ok; else bad "expected exit $1, got $RC. Output:
$OUT"; fi
}

assert_has() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then ok; else bad "expected to see \"$1\". Output:
$OUT"; fi
}

assert_lacks() {
  if printf '%s' "$OUT" | grep -qF -- "$1"; then bad "did not expect \"$1\". Output:
$OUT"; else ok; fi
}

# A migration written the way this repo writes them, so the "correct shape"
# cases are the real thing rather than the minimum that satisfies a regex.
good_migration() { # path table
  cat >"$root/$1" <<SQL
-- What this changes for a person, and why now.
create table if not exists $2 (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  note text
);

alter table $2 enable row level security;

revoke all on $2 from anon, authenticated;
grant select on $2 to authenticated;
grant all on $2 to service_role;

create policy "${2}_select" on $2
  for select to authenticated
  using (not public.is_partner_user() and true);
SQL
}

# ---------------------------------------------------------------------------
# Nothing to say
# ---------------------------------------------------------------------------
new_case "a pull request that breaks no rule is green"
echo "export const x = 1;" >"$root/app/src/lib/thing.ts"
base_commit
echo "export const y = 2;" >>"$root/app/src/lib/thing.ts"
head_commit "Add a thing an installer can use"
run
assert_rc 0
assert_has "nothing to report"

# ---------------------------------------------------------------------------
# String(err)
# ---------------------------------------------------------------------------
new_case "an error rendered with String(err) is reported"
echo "export const x = 1;" >"$root/app/src/pages/Sheet.tsx"
base_commit
echo 'toast(`Could not save: ${String(err)}`);' >>"$root/app/src/pages/Sheet.tsx"
head_commit "Tell the crew when a save did not land"
run
assert_rc 1
assert_has "error-string"
assert_has "app/src/pages/Sheet.tsx:2"
assert_has "formatApiError"

new_case "a String(err) that was already there is not this pull request's problem"
printf 'const a = 1;\ntoast(String(err));\n' >"$root/app/src/pages/Sheet.tsx"
base_commit
printf 'const a = 1;\ntoast(String(err));\nconst b = 2;\n' >"$root/app/src/pages/Sheet.tsx"
head_commit "Add a line to a file that already had a problem"
run
assert_rc 0
assert_lacks "error-string"

new_case "the error formatter itself may touch the raw value"
echo "export const x = 1;" >"$root/app/src/lib/errors.ts"
base_commit
echo '  if (typeof err === "number") return String(err);' >>"$root/app/src/lib/errors.ts"
head_commit "Say something useful when a number is thrown"
run
assert_rc 0
assert_lacks "error-string"

new_case "a test may write the shape it is testing"
mkdir -p "$root/app/src/lib"
echo "export const x = 1;" >"$root/app/src/lib/errors.test.ts"
base_commit
echo 'expect(fmt(err)).not.toBe(String(err));' >>"$root/app/src/lib/errors.test.ts"
head_commit "Prove the formatter beats the bare string"
run
assert_rc 0
assert_lacks "error-string"

# ---------------------------------------------------------------------------
# profiles select("*")
# ---------------------------------------------------------------------------
new_case "select(\"*\") against profiles is reported"
echo "export const x = 1;" >"$root/app/src/lib/people.ts"
base_commit
printf 'const r = await supabase.from("profiles").select("*");\n' >>"$root/app/src/lib/people.ts"
head_commit "Read the crew list"
run
assert_rc 1
assert_has "profiles-star"
assert_has "pin_hash"

new_case "select(\"*\") against another table is left alone"
echo "export const x = 1;" >"$root/app/src/lib/people.ts"
base_commit
printf 'const r = await supabase.from("packages").select("*");\n' >>"$root/app/src/lib/people.ts"
head_commit "Read the package list"
run
assert_rc 0
assert_lacks "profiles-star"

# ---------------------------------------------------------------------------
# Hand-written "table isn't there yet"
# ---------------------------------------------------------------------------
new_case "a hand-written missing-table check is reported"
echo "export const x = 1;" >"$root/app/src/lib/api.ts"
base_commit
printf 'if (error?.code === "PGRST205") return [];\n' >>"$root/app/src/lib/api.ts"
head_commit "Empty the screen instead of crashing"
run
assert_rc 1
assert_has "inline-missing-table"
assert_has "isMissingTable"

new_case "schemaErrors.ts is where that check lives"
mkdir -p "$root/app/src/lib"
echo "export const x = 1;" >"$root/app/src/lib/schemaErrors.ts"
base_commit
printf 'const MISSING = new Set(["PGRST205", "42P01"]);\n' >>"$root/app/src/lib/schemaErrors.ts"
head_commit "Recognise one more way a table can be absent"
run
assert_rc 0
assert_lacks "inline-missing-table"

# ---------------------------------------------------------------------------
# A second file input that offers pictures
# ---------------------------------------------------------------------------
new_case "a new image file input outside usePhotoPicker is reported"
echo "export const x = 1;" >"$root/app/src/pages/Damage.tsx"
base_commit
printf '<input\n  type="file"\n  accept="image/*"\n/>\n' >>"$root/app/src/pages/Damage.tsx"
head_commit "Let a foreman attach a picture of the damage"
run
assert_rc 1
assert_has "photo-file-input"

new_case "a file input for a spreadsheet is not a photo picker"
echo "export const x = 1;" >"$root/app/src/pages/Import.tsx"
base_commit
printf '<input\n  type="file"\n  accept=".csv"\n/>\n' >>"$root/app/src/pages/Import.tsx"
head_commit "Take the catalog in as a spreadsheet"
run
assert_rc 0
assert_lacks "photo-file-input"

new_case "usePhotoPicker may write both of its inputs"
echo "export const x = 1;" >"$root/app/src/lib/photo/usePhotoPicker.tsx"
base_commit
printf '<input type="file" accept="image/*" capture="environment" />\n' >>"$root/app/src/lib/photo/usePhotoPicker.tsx"
head_commit "Keep the camera input pointed at the camera"
run
assert_rc 0
assert_lacks "photo-file-input"

# ---------------------------------------------------------------------------
# Spanish that is English
# ---------------------------------------------------------------------------
new_case "a Spanish string that repeats the English is reported"
printf 'export const CATALOG = {\n};\n' >"$root/app/src/lib/i18n/catalog.ts"
base_commit
printf 'export const CATALOG = {\n  "clock.go": { en: "Clock in", es: "Clock in" },\n};\n' \
  >"$root/app/src/lib/i18n/catalog.ts"
head_commit "Add the clock-in button to the phrasebook"
run
assert_rc 1
assert_has "spanish-copies-english"
assert_has "clock.go"

new_case "a word that is the same word in both languages can say so"
printf 'export const CATALOG = {\n};\n' >"$root/app/src/lib/i18n/catalog.ts"
base_commit
printf 'export const CATALOG = {\n  // i18n-same-on-purpose: a PDF is a PDF.\n  "receipt.pdfTag": { en: "PDF", es: "PDF" },\n};\n' \
  >"$root/app/src/lib/i18n/catalog.ts"
head_commit "Tag a receipt that kept its original file"
run
assert_rc 0
assert_lacks "spanish-copies-english"

new_case "a real translation, written over several lines, is left alone"
printf 'export const CATALOG = {\n};\n' >"$root/app/src/lib/i18n/catalog.ts"
base_commit
printf 'export const CATALOG = {\n  "clock.title.break": {\n    en: "Go on break",\n    es: "Tomar un descanso",\n  },\n};\n' \
  >"$root/app/src/lib/i18n/catalog.ts"
head_commit "Add the break button to the phrasebook"
run
assert_rc 0
assert_lacks "spanish-copies-english"

# ---------------------------------------------------------------------------
# New tables
# ---------------------------------------------------------------------------
new_case "a new table written the house way is green"
base_commit
good_migration "supabase/migrations/20300101000000_tailgate.sql" tailgate_checks
head_commit "Check a truck in one window at a time"
run
assert_rc 0
assert_lacks "table-without-rls"
assert_lacks "table-keeps-default-grants"
assert_lacks "policy-without-partner-guard"

new_case "the shape this repo really writes — a policy inside do \$\$ — is green"
# Taken from supabase/migrations/20260982000000_who_did_what.sql. 49 migrations
# here create their policies this way so that a replay is a no-op. The rules
# used to be blind to every one of them, and went red on two MERGED migrations
# whose policies do carry the guard.
base_commit
cat >"$root/supabase/migrations/20300101000000_tailgate.sql" <<'SQL'
create table if not exists tailgate_checks (
  id uuid primary key,
  /* Who signed it off, and when. A crew member's own row is theirs. */
  signed_by uuid
);

do $$
begin
  if not exists (
    select 1 from pg_tables
    where tablename = 'tailgate_checks' and rowsecurity
  ) then
    alter table tailgate_checks enable row level security;
  end if;
end;
$$;

revoke all on tailgate_checks from anon, authenticated;
grant select on tailgate_checks to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'tailgate_checks' and policyname = 'crew read'
  ) then
    create policy "crew read" on tailgate_checks
      for select to authenticated
      using (not public.is_partner_user() and public.my_role_rank() >= 0);
  end if;
end;
$$;
SQL
head_commit "Check a truck in one window at a time"
run
assert_rc 0
assert_lacks "table-without-rls"
assert_lacks "table-keeps-default-grants"
assert_lacks "policy-without-partner-guard"

new_case "a policy inside do \$\$ that forgets the guard is still reported"
# The other half of the case above: descending into the block must not mean
# waving it through.
base_commit
cat >"$root/supabase/migrations/20300101000000_tailgate.sql" <<'SQL'
create table if not exists tailgate_checks (
  id uuid primary key
);
alter table tailgate_checks enable row level security;
revoke all on tailgate_checks from anon, authenticated;
grant select on tailgate_checks to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'tailgate_checks' and policyname = 'crew read'
  ) then
    create policy "crew read" on tailgate_checks
      for select to authenticated using (true);
  end if;
end;
$$;
SQL
head_commit "Add somewhere to record a tailgate check"
run
assert_rc 1
assert_has "policy-without-partner-guard"

new_case "a function body that only MENTIONS a policy does not stand in for one"
# Why the do-block descent is narrow: the body of a create function is still
# blanked whole, so prose or dynamic SQL inside it cannot satisfy a check.
base_commit
cat >"$root/supabase/migrations/20300101000000_tailgate.sql" <<'SQL'
create table if not exists tailgate_checks (
  id uuid primary key
);
alter table tailgate_checks enable row level security;
revoke all on tailgate_checks from anon, authenticated;
grant select on tailgate_checks to authenticated;

create or replace function public.explain_wall()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- create policy "crew read" on tailgate_checks using (not public.is_partner_user())
  return 'every crew table carries the guard';
end;
$fn$;

revoke all on function public.explain_wall() from public, anon;
grant execute on function public.explain_wall() to authenticated;
SQL
head_commit "Say what the wall is, in one place"
run
assert_rc 1
assert_has "policy-without-partner-guard"

new_case "a new table with no row security is reported"
base_commit
cat >"$root/supabase/migrations/20300101000000_tailgate.sql" <<'SQL'
create table if not exists tailgate_checks (
  id uuid primary key
);
revoke all on tailgate_checks from anon, authenticated;
grant select on tailgate_checks to authenticated;
create policy "tailgate_select" on tailgate_checks
  for select to authenticated using (not public.is_partner_user());
SQL
head_commit "Add somewhere to record a tailgate check"
run
assert_rc 1
assert_has "table-without-rls"

new_case "a new table that keeps its default grants is reported"
base_commit
cat >"$root/supabase/migrations/20300101000000_tailgate.sql" <<'SQL'
create table if not exists tailgate_checks (
  id uuid primary key
);
alter table tailgate_checks enable row level security;
create policy "tailgate_select" on tailgate_checks
  for select to authenticated using (not public.is_partner_user());
SQL
head_commit "Add somewhere to record a tailgate check"
run
assert_rc 1
assert_has "table-keeps-default-grants"

new_case "a crew-readable table with no partner guard is reported"
base_commit
cat >"$root/supabase/migrations/20300101000000_tailgate.sql" <<'SQL'
create table if not exists tailgate_checks (
  id uuid primary key
);
alter table tailgate_checks enable row level security;
revoke all on tailgate_checks from anon, authenticated;
grant select on tailgate_checks to authenticated;
create policy "tailgate_select" on tailgate_checks
  for select to authenticated using (true);
SQL
head_commit "Add somewhere to record a tailgate check"
run
assert_rc 1
assert_has "policy-without-partner-guard"

new_case "a table no browser may touch does not need a policy"
base_commit
cat >"$root/supabase/migrations/20300101000000_audit.sql" <<'SQL'
-- Written by a trigger, read by nobody with a login. The service role is the
-- only caller there is.
create table if not exists points_audit (
  id uuid primary key
);
alter table points_audit enable row level security;
revoke all on points_audit from anon, authenticated;
grant all on points_audit to service_role;
SQL
head_commit "Keep a record of every points change"
run
assert_rc 0
assert_lacks "policy-without-partner-guard"

new_case "prose in a comment cannot stand in for a policy"
base_commit
cat >"$root/supabase/migrations/20300101000000_tailgate.sql" <<'SQL'
create table if not exists tailgate_checks (
  id uuid primary key
);
alter table tailgate_checks enable row level security;
revoke all on tailgate_checks from anon, authenticated;
grant select on tailgate_checks to authenticated;
comment on table tailgate_checks is
  'A create policy on tailgate_checks with not public.is_partner_user() would go here.';
SQL
head_commit "Add somewhere to record a tailgate check"
run
assert_rc 1
assert_has "policy-without-partner-guard"

# ---------------------------------------------------------------------------
# SECURITY DEFINER
# ---------------------------------------------------------------------------
new_case "a definer function without a pinned search path is reported"
base_commit
cat >"$root/supabase/migrations/20300101000000_worked.sql" <<'SQL'
create or replace function public.my_jobs()
returns setof uuid
language sql
stable
security definer
as $$
  select project_id from time_shifts where profile_id = auth.uid();
$$;
grant execute on function public.my_jobs() to authenticated;
SQL
head_commit "List the jobs a person has worked"
run
assert_rc 1
assert_has "definer-without-search-path"

new_case "a definer function nobody is told to call is reported"
base_commit
cat >"$root/supabase/migrations/20300101000000_worked.sql" <<'SQL'
create or replace function public.my_jobs()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select project_id from time_shifts where profile_id = auth.uid();
$$;
SQL
head_commit "List the jobs a person has worked"
run
assert_rc 1
assert_has "definer-without-grant"

new_case "a definer function written the house way is green"
base_commit
cat >"$root/supabase/migrations/20300101000000_worked.sql" <<'SQL'
create or replace function public.my_jobs()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select project_id from time_shifts where profile_id = auth.uid();
$$;

comment on function public.my_jobs() is
  'The jobs the caller has worked; every branch is keyed to auth.uid().';

revoke all on function public.my_jobs() from public, anon;
grant execute on function public.my_jobs() to authenticated, service_role;
SQL
head_commit "List the jobs a person has worked"
run
assert_rc 0
assert_lacks "definer-without"

new_case "an internal definer helper may say that nobody calls it"
base_commit
cat >"$root/supabase/migrations/20300101000000_helper.sql" <<'SQL'
create or replace function public.merge_ranges(a jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $$ select a; $$;

-- Internal: nothing in a browser calls this.
revoke all on function public.merge_ranges(jsonb) from public, anon, authenticated;
SQL
head_commit "Fold one watched stretch into the rest"
run
assert_rc 0
assert_lacks "definer-without-grant"

# ---------------------------------------------------------------------------
# Migration version numbers — the 2026-09-06 collision
# ---------------------------------------------------------------------------
new_case "a version master already holds under another name is reported"
: >"$root/supabase/migrations/20260993000000_learning_time.sql"
base_commit
: >"$root/supabase/migrations/20260993000000_installer_gallery.sql"
head_commit "Show an installer only the photos from jobs they worked"
run
assert_rc 1
assert_has "migration-version-taken"

new_case "a version that sorts below master's newest is reported"
: >"$root/supabase/migrations/20260995000000_gallery.sql"
base_commit
: >"$root/supabase/migrations/20260990000000_older.sql"
head_commit "Add a migration with a number from last week"
run
assert_rc 1
assert_has "migration-version-behind"

new_case "the next free number is green"
: >"$root/supabase/migrations/20260995000000_gallery.sql"
base_commit
: >"$root/supabase/migrations/20260996000000_next.sql"
head_commit "Add a migration with the next number"
run
assert_rc 0
assert_lacks "[migration-version"

new_case "a number an open branch has already claimed is reported"
: >"$root/supabase/migrations/20260995000000_gallery.sql"
base_commit
git -C "$root" checkout -q -b rival
: >"$root/supabase/migrations/20260996000000_rival.sql"
git -C "$root" add -A
git -C "$root" commit -q -m "Claim the next number first"
git -C "$root" update-ref refs/remotes/origin/rival "$(git -C "$root" rev-parse HEAD)"
git -C "$root" checkout -q master
: >"$root/supabase/migrations/20260996000000_mine.sql"
head_commit "Claim the next number second"
stub_gh rival
GH_BIN_OVERRIDE=gh run
unset GH_BIN_OVERRIDE
assert_rc 1
assert_has "migration-version-claimed"
assert_has "rival"

new_case "no gh means a note, never a red build"
: >"$root/supabase/migrations/20260995000000_gallery.sql"
base_commit
: >"$root/supabase/migrations/20260996000000_next.sql"
head_commit "Add a migration with the next number"
run
assert_rc 0
assert_has "note: gh is not on the PATH"

# ---------------------------------------------------------------------------
# Commit subjects
# ---------------------------------------------------------------------------
new_case "a conventional-commit subject is reported"
echo "export const x = 1;" >"$root/app/src/lib/thing.ts"
base_commit
echo "export const y = 2;" >>"$root/app/src/lib/thing.ts"
head_commit "feat(install): add a thing"
run
assert_rc 1
assert_has "commit-subject-conventional"

new_case "a plain sentence about a person is what this repo writes"
echo "export const x = 1;" >"$root/app/src/lib/thing.ts"
base_commit
echo "export const y = 2;" >>"$root/app/src/lib/thing.ts"
head_commit "Stop windows showing as being installed for days on end"
run
assert_rc 0
assert_lacks "commit-subject-conventional"

# ---------------------------------------------------------------------------
echo
if [ "$failed" -eq 0 ]; then
  echo "advisory-rules: $passed checks passed"
  exit 0
fi
echo "advisory-rules: $failed FAILED, $passed passed"
exit 1

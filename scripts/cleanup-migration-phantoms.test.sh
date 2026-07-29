#!/usr/bin/env bash
# Tests for scripts/cleanup-migration-phantoms.sh.
#
# What is being pinned here is the DIRECTION of the check, because that is the
# part that was wrong. The script used to assert three committed integers —
# files on disk, rows in the history table, phantoms — and every one of them
# went stale the moment anybody merged a migration or applied SQL through MCP.
# The tests below exist so nobody quietly turns it back into an equality check:
#
#   * more phantoms than last time      -> still exit 0. Reported, not refused.
#   * a migration file with no row      -> exit 1, always, no override.
#   * two files claiming one version    -> exit 1, always, no override.
#
# Each case builds a throwaway repo — the script cds relative to its own path,
# so a copy of it next to a fixture supabase/migrations/ is a complete world —
# and stubs `curl`, so nothing here needs a token, a project or a network, and
# nothing can reach a database.
set -uo pipefail

cd "$(dirname "$0")/.."
src="$PWD/scripts/cleanup-migration-phantoms.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass=0
fail=0
LAST_OUT=""

# world <name> <files…> -- <remote versions…>
# Builds a fake repo whose migrations/ holds <files> and whose history table
# answers with <remote versions>, and echoes the path to run the script from.
world() {
  local name="$1"; shift
  local root="$work/$name"
  mkdir -p "$root/scripts" "$root/supabase/migrations" "$root/bin"
  cp "$src" "$root/scripts/"

  local mode=files rows=()
  for arg in "$@"; do
    if [ "$arg" = "--" ]; then mode=remote; continue; fi
    if [ "$mode" = files ]; then
      : >"$root/supabase/migrations/$arg"
    else
      rows+=("$arg")
    fi
  done

  # The history table's answer, in the Management API's shape.
  {
    printf '['
    local first=1 v
    for v in "${rows[@]:-}"; do
      [ -z "$v" ] && continue
      [ "$first" = 1 ] || printf ','
      first=0
      printf '{"version":"%s","name":"stub"}' "$v"
    done
    printf ']'
  } >"$root/remote.json"

  # Stub curl: honour -o, print the HTTP code the script reads from -w.
  cat >"$root/bin/curl" <<EOF
#!/usr/bin/env bash
out=""
while [ \$# -gt 0 ]; do
  case "\$1" in -o) out="\$2"; shift 2 ;; *) shift ;; esac
done
[ -n "\$out" ] && cp "$root/remote.json" "\$out"
printf '200'
EOF
  chmod +x "$root/bin/curl"
  printf '%s' "$root"
}

# run <name> <expected-exit> <root> [extra env…]
run() {
  local name="$1" want="$2" root="$3"; shift 3
  local out
  out="$(cd "$root" && env PATH="$root/bin:$PATH" \
        SUPABASE_ACCESS_TOKEN=sbp_test SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
        "$@" bash scripts/cleanup-migration-phantoms.sh 2>&1)"
  local got=$?
  LAST_OUT="$out"
  if [ "$got" != "$want" ]; then
    echo "FAIL: $name — exit $got, expected $want"
    echo "$out" | sed 's/^/      /'
    fail=$((fail + 1))
    return
  fi
  echo "ok: $name"
  pass=$((pass + 1))
}

expect() {
  local name="$1" needle="$2"
  case "$LAST_OUT" in
    *"$needle"*) echo "ok: $name"; pass=$((pass + 1)) ;;
    *) echo "FAIL: $name — output lacked: $needle"
       echo "$LAST_OUT" | sed 's/^/      /'
       fail=$((fail + 1)) ;;
  esac
}

# --- phantoms are reported, never refused -----------------------------------
two_phantoms="$(world two 20260101000000_a.sql 20260102000000_b.sql \
  -- 20260101000000 20260102000000 20251201000000 20260103000000)"
run "phantoms alone do not stop the script" 0 "$two_phantoms"
expect "  it counts them" "2 phantom rows"
expect "  and writes nothing" "Preview only. Nothing was written."

# The whole point of the rewrite: the same repo with MORE phantoms is still a
# pass. Under the old equality gate this was the case that refused and had to
# be silenced by bumping a committed literal.
five_phantoms="$(world five 20260101000000_a.sql 20260102000000_b.sql \
  -- 20260101000000 20260102000000 20251201000000 20260103000000 \
     20260104000000 20260105000000 20260106000000)"
run "MORE phantoms than before is still a pass" 0 "$five_phantoms"
expect "  and the new count is simply reported" "5 phantom rows"

# --- a new phantom is still visible, not silent ------------------------------
run "a phantom newer than every file is called out separately" 0 "$five_phantoms"
expect "  by count" "of which 4 sort after every migration file"
expect "  and by name, with why it appeared" "stamped by something applying SQL outside"

# --- the genuinely wrong things still stop it --------------------------------
unapplied="$(world unapplied 20260101000000_a.sql 20260102000000_b.sql \
  -- 20260101000000 20251201000000)"
run "a migration file with no applied row STOPS it" 1 "$unapplied"
expect "  and says which direction the problem is" "no row at all for 1 of the migration"
expect "  and offers no way round it" "There is no override."

dupes="$(world dupes 20260101000000_a.sql 20260101000000_b.sql \
  -- 20260101000000)"
run "two files claiming one version STOPS it" 1 "$dupes"
expect "  and names the version" "20260101000000"
expect "  and names both files" "20260101000000_a.sql 20260101000000_b.sql"

# --- the happy end state -----------------------------------------------------
clean="$(world clean 20260101000000_a.sql 20260102000000_b.sql \
  -- 20260101000000 20260102000000)"
run "a history table with no phantoms is a no-op" 0 "$clean"
expect "  and says so" "Nothing to do"

# --- the opt-in numeric pin still works when someone asks for it -------------
run "EXPECT_PHANTOMS is honoured when deliberately exported" 1 "$two_phantoms" EXPECT_PHANTOMS=99
expect "  and says what it found instead" "but there are 2"
run "EXPECT_PHANTOMS matching is a pass" 0 "$two_phantoms" EXPECT_PHANTOMS=2

# --- it still refuses to guess which database it is looking at ---------------
out="$(cd "$two_phantoms" && env PATH="$two_phantoms/bin:$PATH" \
      SUPABASE_ACCESS_TOKEN=sbp_test -u SUPABASE_PROJECT_REF \
      bash scripts/cleanup-migration-phantoms.sh 2>&1)"
if [ $? -eq 0 ]; then
  echo "FAIL: an unnamed project should not be a pass"; fail=$((fail + 1))
else
  echo "ok: it still refuses to guess the project"; pass=$((pass + 1))
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

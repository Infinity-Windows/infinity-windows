# Split a Postgres migration into statements, so a rule can ask a question
# about one CREATE TABLE without a regex tripping over the file around it.
#
# WHY THIS IS NOT `tr ';' '\n'`. Three things in these migrations contain a
# semicolon that does not end a statement:
#
#   * a function body between `$$` (or `$function$`) markers — every RPC here
#     has one, and they are full of `;`
#   * a `comment on ... is '...'` string, which in this repo runs to whole
#     paragraphs of prose with punctuation in it
#   * a `--` comment, which is where most of this repo's thinking lives
#   * a `/* ... */` block comment, which nests in Postgres
#
# THE BLOCK COMMENT IS NOT OPTIONAL to handle, though it looks rare. It is
# prose, so it contains apostrophes — `a job's window schedule` — and an
# unpaired apostrophe read as the start of a `'...'` literal swallows the rest
# of the file. That is what 20260813010000_studio_units.sql did: the whole
# migration came out as ONE statement, and every question asked of it was
# answered by accident.
#
# Splitting naively cuts a function in half and the halves then answer
# questions wrongly — a body containing the words "create policy" would be read
# as a policy. So this tracks all three states and emits one record per real
# statement.
#
# WHAT IT THROWS AWAY, on purpose. FUNCTION bodies and string literals are
# replaced by a single space, and comments are dropped. Every rule that uses
# this asks about a statement's HEADER — is RLS enabled, does this policy name
# the partner guard, does this function say `set search_path` — and all of that
# is outside the body. Keeping function bodies would mean a policy's prose
# could satisfy the check that its policy text is missing.
#
# WHAT IT DOES *NOT* THROW AWAY, and why that had to change. An anonymous
# `do $$ ... $$;` block is the opposite case: in this repository it is not
# logic that MENTIONS DDL, it is the ordinary way DDL is WRITTEN — 49 of the
# migrations here create their policies inside
# `do $$ begin if not exists (...) then create policy ... end if; end; $$;`
# so that a replay is a no-op. Blanking those bodies made the rules blind to
# nearly every policy this repo has ever written: on 2026-09-06 the
# partner-guard rule went red on two MERGED migrations
# (20260982000000_who_did_what.sql, 20260983000000_credentials.sql) whose
# policies do carry `not public.is_partner_user()`, twenty lines below a
# `do $$`. A rule that fires on correct code is worse than no rule, and this
# one is on the job the owner may mark required.
#
# So a `$$` body is descended into WHEN THE STATEMENT SO FAR IS EXACTLY `do`,
# and skipped otherwise. Inside it the same rules apply — `--` comments,
# `'...'` literals and `;` boundaries — so the DDL comes out as statements,
# while a create-function body a few lines later is still blanked whole.
# A differently-tagged block nested inside (`$fn$ ... $fn$`) is still skipped,
# which is what makes a create-function inside a do block behave.
#
# Output: one line per statement, `startline<TAB>normalised lowercase text`,
# where startline is the line the statement's first non-blank character is on,
# so a finding can be reported as file:line.
#
# Used by scripts/advisory-rules.sh; tested through scripts/advisory-rules.test.sh.

function append(t, n) {
  if (t ~ /[^ \t]/ && start == 0) start = n
  stmt = stmt " " t
}

function flush() {
  if (stmt ~ /[^ \t]/) {
    gsub(/[ \t]+/, " ", stmt)
    sub(/^ /, "", stmt)
    sub(/ $/, "", stmt)
    print start "\t" tolower(stmt)
  }
  stmt = ""
  start = 0
}

# The statement built so far, normalised, so the scanner can ask whether it is
# standing at the `$$` of a `do` block rather than at a function body.
function sofar(   s) {
  s = stmt " " out
  gsub(/[ \t]+/, " ", s)
  sub(/^ /, "", s)
  sub(/ $/, "", s)
  return tolower(s)
}

BEGIN { stmt = ""; start = 0; indq = 0; tag = ""; insq = 0; dotag = ""; incm = 0 }

{
  line = $0
  out = ""
  i = 1
  L = length(line)
  while (i <= L) {
    if (indq) {
      # Inside a $$ body: skip everything until the matching closing tag.
      p = index(substr(line, i), tag)
      if (p == 0) { i = L + 1 } else { i = i + p - 1 + length(tag); indq = 0; tag = "" }
      continue
    }
    if (incm) {
      # Inside a /* ... */ block comment. Postgres nests them, so this counts.
      if (substr(line, i, 2) == "*/") { incm--; i += 2; continue }
      if (substr(line, i, 2) == "/*") { incm++; i += 2; continue }
      i++
      continue
    }
    if (insq) {
      # Inside a '...' literal, which may run past the end of a line. Two
      # single quotes in a row are an escaped quote and do not close it.
      c = substr(line, i, 1)
      if (c == "'") {
        if (substr(line, i + 1, 1) == "'") { i += 2; continue }
        insq = 0; i++; continue
      }
      i++
      continue
    }
    c = substr(line, i, 1)
    if (substr(line, i, 2) == "--") { i = L + 1; continue }
    if (substr(line, i, 2) == "/*") { incm = 1; i += 2; out = out " "; continue }
    if (c == "$") {
      rest = substr(line, i)
      if (match(rest, /^\$[A-Za-z_0-9]*\$/)) {
        marker = substr(rest, 1, RLENGTH)
        if (dotag != "" && marker == dotag) {
          # The `$$` that closes the do block we are already reading through.
          dotag = ""
          i += RLENGTH
          out = out " "
          continue
        }
        if (dotag == "" && sofar() == "do") {
          # An anonymous block. Its body is DDL written idempotently, so read
          # it rather than blanking it.
          dotag = marker
          i += RLENGTH
          out = out " "
          continue
        }
        tag = marker
        indq = 1
        i += RLENGTH
        out = out " "
        continue
      }
    }
    if (c == "'") { insq = 1; i++; out = out " "; continue }
    if (c == ";") {
      append(out, NR)
      out = ""
      flush()
      i++
      continue
    }
    out = out c
    i++
  }
  append(out, NR)
  out = ""
}

END { flush() }

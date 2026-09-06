# 10 — Lint checks that encode incidents

Status: ready-for-agent
Type: task
Size: S

## Horizon does

`eslint.config.js`: a `no-restricted-syntax` rule bans a raw camera
`capture` attribute with a message that points at `usePhotoCapture()` (the
iOS limited-picker incident); `no-restricted-imports` bans `server-only`.
`scripts/check-field-design.mjs` fails CI when field screens use banned
micro-typography or raw color utilities instead of tokens.
`scripts/check-project-assignment-writes.mjs` bans a blind `.insert()` on a
table whose unique key ignores `active`.

## Forge today

`.oxlintrc.json` has two rules. The lessons that cost the most live only as
prose in `CLAUDE.md`: never render `String(err)` (leaks Postgres constraint
names to installers), never import the other `formatApiError` across the
`install/` boundary, and column selects on `profiles` are explicit.

## Build

`scripts/check-house-rules.sh` + test, run in `ci.yml`, one rule per block
with the incident in a comment:
1. `String(err)` / `${err}` / `err.message` rendered in a `.tsx` under
   `app/src` → fail, "use formatApiError(err)". Allow-list with reasons.
2. A file under `app/src/pages/install/` or `app/src/lib/install/` importing
   `lib/errors` (or the reverse importing `lib/install/errors`) → fail.
3. `.from("profiles").select("*")` anywhere → fail.
4. A raw `<input type="file" capture` outside `PhotoCaptureSheet.tsx` → fail
   (Forge already has a sanctioned capture path; name it in the message).
5. A new hand-written `isMissingTable`-style check (`code === "42P01"` or
   `PGRST205` outside `lib/schemaErrors.ts`) → fail.

Also try oxlint's own `no-restricted-imports` for rule 2 if the installed
version supports it; the script stays the source of truth either way.

## Done when

- Each rule has a fixture that fails and one that passes in the test.
- CI is green on master today (fix or allow-list, with reasons, anything the
  first run finds — report the list in the PR).

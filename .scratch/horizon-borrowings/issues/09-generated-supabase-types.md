# 09 — Generated Supabase types

Status: ready-for-agent
Type: task
Size: M

## Horizon does

`src/integrations/supabase/types.ts` (6,833 lines) is the `supabase gen types`
output; the client is `createClient<Database>`, so every `.from("x").select()`
is typed against the real schema and a renamed column fails `tsc`. Their
AGENTS.md says to regenerate it whenever a migration lands.

## Forge today

Row shapes are hand-written interfaces next to their api modules
(`lib/install/types.ts`, `lib/install/api.ts` at 4,233 lines is the biggest),
and column lists are explicit constants (`PROFILE_COLS`, `OPENING_SELECT`)
because `profiles.pin_hash` must never be selected. A migration that renames a
column and a query that still selects the old name both compile today.

## Build

1. Generate `app/src/lib/database.types.ts` from the live schema
   (`supabase gen types typescript --project-id czprjcskmzzagdztqonm`) and add
   an npm script `types:gen`. Commit the output.
2. Type the client: `createClient<Database>` in `lib/supabase.ts`. Expect a
   wave of `tsc` errors — that is the point. Fix them module by module,
   starting with `lib/install/api.ts`, keeping the explicit column constants
   (they are a security rule, not a typing shortcut; write that comment).
3. A CI step that regenerates and diffs: if the committed file is stale after
   a migration merges, the PR goes red with "run npm run types:gen". Runs in
   `deploy-backend.yml` after `db push`, and on PRs that touch
   `supabase/migrations/**` (read-only, uses the management token).
4. `CLAUDE.md`: how to regenerate, and that `select("*")` on `profiles` still
   fails by design.

## Done when

- `tsc -b` is green with the typed client.
- Renaming a column in a scratch migration (not applied) and regenerating
  makes the stale select fail to compile.
- The `PROFILE_COLS` discipline survives (a test that `select("*")` on
  profiles is not present anywhere: grep in a script test).

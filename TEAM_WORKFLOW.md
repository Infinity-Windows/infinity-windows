# Team workflow — how Taylor + Ammon build without breaking each other

The goal: `master` is always working, and nobody ever loses work or overwrites
someone else. These rules apply to **both people and any AI agent** you run.

## The golden rules
1. **Never edit `master` directly.** Every change goes through a branch + Pull Request.
2. **Pull `master` before you start anything:**
   ```bash
   git checkout master && git pull
   ```
3. **Work on your own branch, named for you + the task:**
   ```bash
   git checkout -b ammon/plan-upload      # or taylor/reskin-mywork
   ```
4. **Small and frequent beats big and rare.** Ship one screen/feature per PR and
   merge it the same day if you can. Giant week-long branches are what cause
   painful conflicts.
5. **Open a PR to merge** (never push straight to master). The other person (or
   you) reviews and clicks Merge. CI must be green first (see below).
6. **After a merge, everyone pulls master** before continuing:
   ```bash
   git checkout master && git pull
   ```

## Who owns what (avoid editing the same files at once)
Agree on lanes so you're not both rewriting the same screen. Example split:
- **Ammon:** design/reskin + plan-upload/map (`app/src/pages/install/*`, styling).
- **Taylor:** ops screens + data/flywheel (`Points`, `TimeClock`, `Costing`, `Qc`, `Analytics`).

Adjust as needed — just don't both take the same file in the same day.

## Database changes (shared Supabase)
You share ONE database, so a schema change affects both of you.
- New DB change = a new file in `supabase/migrations/` (timestamp-prefixed).
- The migration must be **additive and safe** (`add column if not exists`,
  `create table if not exists`) — never drop/overwrite existing data.
- **Announce it in Slack #build** and apply it **once** (Supabase SQL editor or
  the migrations bundle). Say when it's applied so the other person knows.

## CI (automatic safety net)
Every PR runs `.github/workflows/ci.yml`: install, lint, build, and tests.
- A PR can only merge when CI is **green**.
- If CI is red, fix it on your branch before merging — this is what stops
  broken code from ever reaching `master`.

## Secrets
- `.env` (Supabase keys) is **never** committed — it's git-ignored and shared
  privately (DM), never in GitHub or a public Slack channel.

## Local vs cloud agents
- Prefer the **local** Cursor agent for daily building (cheap).
- Use Slack `@Cursor` only for quick/away-from-desk tasks (cloud cost).

## Repo
`taylorhorizon/infinity-windows` (private) · default branch `master`.

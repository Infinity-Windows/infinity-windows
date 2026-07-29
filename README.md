# Window Ops App

Concept prototype for a window installation ops + training brain. Local dev only — perfect these flows before merging into an existing app.

## What's here

- `app/` — Warehouse inventory + install capture PWA (React + Vite + Supabase). Scan-first: QR license plate on every window, QR address on every rack slot.
- `supabase/migrations/` — Database schema + prototype upgrades (also consolidated in [`docs/prototype-migrations.sql`](docs/prototype-migrations.sql) for paste into the SQL editor).
- `supabase/functions/` — OpenAI Edge Functions: Whisper transcription + topic split, tip synthesis, AI schedule extract fallback.
- `scripts/weekly-report.mjs` / `scripts/vault-sync.mjs` — Manual laptop scripts that write markdown into `vault/`.
- `docs/` — Planning notes, hardware list, [catalog CSV template](docs/window-types-template.csv), the [$1M→$10M scaling roadmap](docs/roadmap-scale-1m-to-10m.md), and the [10x plan](docs/roadmap-10x.md).
- `vault/` — Obsidian-friendly markdown mirror (wiki view; DB remains system of truth).

## Product loops to perfect

1. **Unified job hub** — `/projects/:id` tabs: Overview, Warehouse, Map, Brain.
2. **Single install path** — every install goes through the opening sheet as a
   staged **Check → Install → Capture** flow (exceptions collapse behind "More").
3. **Installer-first** — installers land on **My work** with an install-first
   bottom bar (My work / Clock / Learn / Points / Find); leads run the warehouse bar.
4. **Smart assign & dispatch** — search shows slot + status, prefers staged/loaded,
   sets `project_id`, logs a movement; the dispatch board ranks on learned
   per-installer stats.
5. **Demand rollup** — confirmed openings → `project_windows` quantities.
6. **OpenAI brain** — voice → Whisper + topic fields; tip synthesis + golden video
   in the pre-install briefing; AI extract when deterministic PDF parse finds nothing.

### The flywheel (make it true)

- **QC → learning** — a callback counts as a "problem" in type rollups,
  `learned_difficulty`, and per-installer stats, so rework-prone types route to
  proven-clean installers automatically.
- **Points truth** — install points are **pending** until QC sign-off (confirmed
  on pass, voided on callback); quizzes and the sequence game write real ledger points.
- **Costing truth** — labor cost is derived from clocked `time_shifts` × role rate;
  manual entries are adjustments on top.
- **Education → clearance → dispatch** — a knowledge score (105-term glossary +
  18-step procedure, spaced-repetition + games) gates clearance suggestions, which
  gate what dispatch can assign.

## Modules

Time clock (server-persisted breaks), job costing, education (Daily 5 / Quiz /
Sequence / Glossary), points & leaderboard, safety talks + incidents, tools,
supplies, QC sign-off, crew + roles, admin access requests, and a device PIN gate
(verified server-side; the PIN value never reaches the client).

## Running locally

```bash
cd app
cp .env.example .env   # already points at the shared project — no editing needed
npm install
npm run dev
```

## Supabase setup

**There is ONE shared Supabase project: `czprjcskmzzagdztqonm`.** It is what the
deployed app at <https://infinity-windows.github.io/infinity-windows/> talks to,
and `app/.env.example` has its URL and anon key filled in, so `cp .env.example .env`
is all you need — do not edit it and do not create your own project. If the app
is ever pointed at a different project it shows a red **"Wrong database"** banner
naming both projects, because work done against the wrong database is invisible
to everyone else.

If you are deliberately working against a different project (a collaborator's,
say), set `VITE_EXPECTED_SUPABASE_PROJECT_REF` in your own `app/.env` to that
project's ref so the banner tracks the project you mean instead of warning on
every screen. That only changes which project the app *expects*; `VITE_SUPABASE_URL`
is still what it connects to. Unset — which is the default for everyone — the
expected project stays `czprjcskmzzagdztqonm`.

(The anon key is in git on purpose: it is already compiled into the JavaScript we
serve publicly. Row-level security, not secrecy of that key, is what protects the
data. Service-role keys, the database password, and the private VAPID key are
never committed.)

1. Paste [`docs/prototype-migrations.sql`](docs/prototype-migrations.sql) into the SQL editor (after the base schema is applied). It bundles all prototype migrations in order and is safe to re-run.
2. Deploy **every** Edge Function in `supabase/functions/`:
   `ask`, `extract-schedule`, `extract-specs`, `generate-howto`,
   `generate-toolbox-talk`, `ingest-knowledge`, `send-push`,
   `synthesize-type-tips`, `transcribe-install-memo`, `vault-config`.

   This list used to name only four functions, so the six added later were never
   deployed. A function that exists in this repo but was never deployed just
   404s at runtime — that is why Ask Infinity fails until `ask` is deployed.
3. Set the Edge Function secrets (never in client / git): `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, and the web-push pair `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` (the public one also goes in `VITE_VAPID_PUBLIC_KEY`).
4. Create crew users under Authentication → Users, then set roles on the Crew screen.

### Shipping the backend

`Deploy GitHub Pages` ships the frontend on every merge to master. `Deploy backend`
([`.github/workflows/deploy-backend.yml`](.github/workflows/deploy-backend.yml))
does the same for Edge Functions and migrations, so the two halves cannot drift
apart the way they did through July 2026 — ten PRs merged whose backend never
left the repo, and no build went red.

It needs two repo secrets. Until those are set, each job is a no-op that
annotates the run with what it would have done, so nothing turns red on its own.

| Secret | What it does | Where an owner gets it |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Deploys the Edge Functions. A personal access token, starts with `sbp_`. | Supabase dashboard → avatar (top right) → Account preferences → [Access Tokens](https://supabase.com/dashboard/account/tokens) → **Generate new token**. Copy it immediately, it is shown once. |
| `SUPABASE_DB_PASSWORD` | Lets `supabase db push` apply migrations. | Dashboard → the project → **Project Settings → Database → Database password**. If nobody still has it, **Reset database password** there — that breaks anything using the old one. |

Install both once, from a checkout of this repo. Each command prompts for the
value and does not echo it, so nothing lands in your shell history or in git:

```bash
gh secret set SUPABASE_ACCESS_TOKEN --repo Infinity-Windows/infinity-windows
gh secret set SUPABASE_DB_PASSWORD  --repo Infinity-Windows/infinity-windows
```

Then re-run it: **Actions → Deploy backend → Run workflow**. Never put either
value in a file in this repo.

The `Verify functions are live` job probes every function in
`supabase/functions/` and reports which ones 404. Before the secrets exist that
is a warning; once they exist it is strict, so a deploy that reported success
while a function is still 404 fails the run. Run the same check yourself any
time — it needs no credentials:

```bash
scripts/verify-functions.sh          # warn on missing
STRICT=1 scripts/verify-functions.sh # exit 1 on missing
```

The bundle seeds the thin modules (tools, a week-long safety-talk rotation) and
adds how-to guides for `CAS3050`, `DH2846`, and `PIC6060` so every screen shows
real content out of the box.

Optional vault mirror (manual):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/vault-sync.mjs
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/weekly-report.mjs
```

## Tests

```bash
cd app && npm test
```

# Window Ops App

Concept prototype for a window installation ops + training brain. Local dev only — perfect these flows before merging into an existing app.

## What's here

- `app/` — Warehouse inventory + install capture PWA (React + Vite + Supabase). Scan-first: QR license plate on every window, QR address on every rack slot.
- `supabase/migrations/` — Database schema + prototype upgrades (also consolidated in [`docs/prototype-migrations.sql`](docs/prototype-migrations.sql) for paste into the SQL editor).
- `supabase/functions/` — OpenAI Edge Functions: Whisper transcription + topic split, tip synthesis, AI schedule extract fallback.
- `scripts/weekly-report.mjs` / `scripts/vault-sync.mjs` — Manual laptop scripts that write markdown into `vault/`.
- `docs/` — Planning notes, hardware list, [catalog CSV template](docs/window-types-template.csv), the [$1M→$10M scaling roadmap](docs/roadmap-scale-1m-to-10m.md), and the [10x plan](docs/roadmap-10x.md).
- `vault/` — Obsidian-friendly markdown mirror (wiki view; DB remains system of truth). The nightly `Vault brain sync` workflow regenerates it and publishes it to the `vault-mirror` branch — point Obsidian's git sync at that branch. These files do **not** ground the Ask / Infinity AI feature; that reads notes uploaded through the app.

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

### Signing in to look at a screen

Nearly every screen needs a login, and public signup is off. There is one test
account for exactly this — an installer, with its password in a gitignored local
file:

```bash
cat .secrets/test-installer.env    # email + password
```

If that file is not there, **do not ask anyone for a password** — regenerate it
yourself in about a minute. That, what the account may and may not touch, and how
its activity is kept out of the crew's real figures:
[`docs/test-account.md`](docs/test-account.md).

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

**None of the steps below are a human's job, and none of them need Supabase
dashboard access.** The agent applies migrations and deploys functions with the
`supabase` CLI and the Management API; only Taylor, who owns the Supabase
organisation, is ever asked for a value that cannot be read programmatically. If an
agent tells you to open supabase.com and click something, that is the agent's bug —
see [`SYNC.md`](SYNC.md#database-changes-supabase--the-agents-job-never-yours).

1. Apply the schema. On every merge to `master`, the `Push migrations` job in
   `Deploy backend` runs `supabase db push` for you, once the two repo secrets in
   [Shipping the backend](#shipping-the-backend) are set; until then it is a no-op
   and the agent applies migrations directly. [`docs/prototype-migrations.sql`](docs/prototype-migrations.sql)
   bundles all prototype migrations in order and is safe to re-run if a database
   ever needs rebuilding from scratch.
2. Deploy **every** Edge Function in `supabase/functions/`:
   `ask`, `extract-schedule`, `extract-specs`, `generate-howto`,
   `generate-toolbox-talk`, `ingest-knowledge`, `send-push`,
   `synthesize-type-tips`, `transcribe-install-memo`, `vault-config`.

   This list used to name only four functions, so the six added later were never
   deployed. A function that exists in this repo but was never deployed just
   404s at runtime — that is why Ask Infinity fails until `ask` is deployed.
3. Set the Edge Function secrets (never in client / git): `OPENAI_API_KEY`,
   `ANTHROPIC_API_KEY`, and the web-push keys `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` — see
   [the table below](#edge-function-secrets) for which function needs which and
   what breaks without it, and [Web push notifications](#web-push-notifications)
   for how the VAPID keys relate to the `VITE_VAPID_PUBLIC_KEY` the frontend
   needs.
4. Create crew users, then set roles on the Crew screen. Creating them is an
   `auth/v1/admin/users` call with the service-role key, so the agent does it — not
   a trip to Authentication → Users in the dashboard.

### Edge Function secrets

These are the difference between a function that is deployed and a function that
works. A function whose secret was never set deploys cleanly, routes correctly,
passes every check in this repo, and returns **500 on every real request**. That
is how Ask Infinity looked healthy in CI and answered nothing for as long as it
existed.

They are consumed from Supabase, but **GitHub is where you set them.** Add a repo
secret under the same name (Settings → Secrets and variables → Actions) and
`Deploy backend` pushes it to the project on the next merge, then checks it is
there, then asks Ask Infinity a real question to prove the key actually works.
Rotating a key is that one change plus a re-run — no dashboard, no redeploy.

Setting one in the Supabase dashboard instead still works, and nothing here will
clear it, but it has no owner, no history, and no way back if the project is ever
rebuilt. Prefer GitHub.

| Secret | Needed by | What breaks without it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `ask`, `extract-schedule`, `extract-specs`, `generate-howto`, `generate-toolbox-talk`, `synthesize-type-tips`, `transcribe-install-memo` | Everything the app writes stops: Ask Infinity answers nothing, plansets and delivery schedules cannot be read, no how-tos, no toolbox talks, no window-type tips, and voice memos are transcribed but never sorted into fields. |
| `OPENAI_API_KEY` | `ingest-knowledge`, `transcribe-install-memo` | Nothing new can be added to the brain, and voice memos are never transcribed. Also degrades two things rather than breaking them: Ask Infinity stops searching documents and answers from live data only, and toolbox talks ship with described placeholders instead of diagrams. |
| `VAPID_PRIVATE_KEY` | `send-push` | Push notifications silently stop. The public half also goes in the app as `VITE_VAPID_PUBLIC_KEY`. |
| `VAPID_PUBLIC_KEY` | `send-push` | Same. |

Optional, with working defaults — set only to override: `ANTHROPIC_MODEL`,
`VAPID_SUBJECT`.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
by the platform. Do not set them by hand.

**The recommended way** — set it once in GitHub and let the pipeline own it. The
command prompts for the value and does not echo it, so nothing lands in your
shell history or in git:

```bash
gh secret set ANTHROPIC_API_KEY --repo Infinity-Windows/infinity-windows
```

Then re-run **Actions → Deploy backend → Run workflow**.
[`scripts/sync-function-secrets.sh`](scripts/sync-function-secrets.sh) pushes
every name in the table above that exists as a repo secret. It only ever adds or
updates those names — it never unsets anything, never renames one secret onto
another, and never prints a value — so it is safe on every merge.

Straight to Supabase also works, if you would rather:

```bash
supabase secrets set ANTHROPIC_API_KEY --project-ref czprjcskmzzagdztqonm
supabase secrets set OPENAI_API_KEY    --project-ref czprjcskmzzagdztqonm
supabase secrets set VAPID_PUBLIC_KEY  --project-ref czprjcskmzzagdztqonm
supabase secrets set VAPID_PRIVATE_KEY --project-ref czprjcskmzzagdztqonm
```

The table above is **derived from the function sources**, not maintained by hand
— the old list of "four functions to deploy" was wrong for months once there
were ten, and a stale secret list would go the same way. Regenerate it any time,
no credentials needed:

```bash
python3 scripts/function_secrets.py          # who needs what, and why
python3 scripts/function_secrets.py --names  # just the required names
```

`Deploy backend` pushes, checks and then *uses* these on every merge once
`SUPABASE_ACCESS_TOKEN` is set. Five separate assertions, because each one sees
something the others cannot:

| Step | What it proves | What it cannot see |
| --- | --- | --- |
| Push the function secrets GitHub holds | The value GitHub has is now the value the project has | Anything GitHub does not hold |
| Verify every required function secret exists | Every needed name is present on the project | Whether the value is any good |
| Check the AI provider accepts our key | Anthropic genuinely accepts the key and generates text | Whether the function around it works |
| Ask Infinity a real question | The whole feature answers, end to end | Anything about the other five writing features |
| Make the other writing features write something | A how-to, a talk, tips and a plan-set read produce real content | — |

The third one exists because a key that is **refused** — cancelled, rotated at
Anthropic, or pasted from the wrong account — is identical to a working key as
far as `supabase secrets list` is concerned, which reports names and digests and
never values. It also separates a key to replace from an account that has simply
run out of credit, which are different jobs.

The fourth needs a caller it can sign in as. `ask` identifies its caller from a
JWT, so a new-format `sb_secret_…` key will not do — set `ASK_SMOKE_JWT` to a
legacy service-role key or a real user's access token. Without one it reports
"could not tell" and warns rather than failing, since it has measured nothing.

The fifth exists because `ask` answering proves nothing about the five *other*
features that generate text. All of them moved from OpenAI to Claude, and the
failure that move risks is not an error but a silence: a toolbox talk saved with
no hazards, a plan set read as zero openings. Both are indistinguishable from
"there was nothing to find" unless something checks the content, so this asks for
output and checks what came back. A feature it cannot exercise for want of data —
no reference install recorded, no install memos yet — is reported **NOT TESTED**,
never as a pass. Same when the credentials on the run can call a function but not
read the database back: three of the four probes need a row read, and "we could
not look" must never be reported as "the feature wrote nothing".

To check by hand:

```bash
SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
  scripts/verify-function-secrets.sh

ANTHROPIC_API_KEY=sk-ant-... scripts/verify-anthropic-key.sh

SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
  ASK_SMOKE_JWT=eyJ... scripts/smoke-ask.sh

SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
  SUPABASE_SERVICE_ROLE_KEY=eyJ... scripts/smoke-text-features.sh
```

### Shipping the backend

`Deploy GitHub Pages` ships the frontend on every merge to master. `Deploy backend`
([`.github/workflows/deploy-backend.yml`](.github/workflows/deploy-backend.yml))
does the same for Edge Functions and migrations, so the two halves cannot drift
apart the way they did through July 2026 — ten PRs merged whose backend never
left the repo, and no build went red.

It needs two repo secrets. Until those are set, each job is a no-op that
annotates the run with what it would have done, so nothing turns red on its own.

Both come from Taylor's Supabase account — he owns the organisation, so nobody else
can read them. Ask Taylor, never Ammon.

| Secret | What it does | Where Taylor gets it |
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
`supabase/functions/` and sorts each one into exactly three buckets: **deployed**
(the platform answered, normally 401 without a token), **missing** (404), and
**undetermined** (no answer at all — DNS failure, refused connection, timeout).
Before the secrets exist all of that is a warning; once they exist it is strict,
and both a missing function *and* an undetermined one fail the run. Undetermined
counts as a failure on purpose: a probe that never got an answer has not proved
anything, and a check that treats "could not tell" as "fine" is how a deploy
that shipped nothing went green in the first place. The failure text says which
of the two it is, so nobody goes hunting for a broken deploy when the real
problem was the network.

Run the same check yourself any time — it needs no credentials:

```bash
scripts/verify-functions.sh          # warn only
STRICT=1 scripts/verify-functions.sh # exit 1 if any are missing or undetermined
scripts/verify-functions.test.sh     # test the checker itself, no network
```

The bundle seeds the thin modules (tools, a week-long safety-talk rotation) and
adds how-to guides for `CAS3050`, `DH2846`, and `PIC6060` so every screen shows
real content out of the box.

Optional vault mirror (manual):

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/vault-sync.mjs
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/weekly-report.mjs
```

### Web push notifications

Push is how an alert reaches a crew member when the app is closed. It needs one
keypair, split across the two halves of the system. The **private** half stays on
Supabase and is what signs each push; the **public** half is compiled into the
JavaScript we serve so the phone knows which server is allowed to push to it.
They only work as a matched pair — replacing one half without the other silently
breaks every device already subscribed.

| Variable | Where it lives | What it is |
| --- | --- | --- |
| `VAPID_PRIVATE_KEY` | Supabase Edge Function secret | The private half. Never in git, never in the client. |
| `VAPID_PUBLIC_KEY` | Supabase Edge Function secret | The public half, so `send-push` can sign as the matching sender. |
| `VAPID_SUBJECT` | Supabase Edge Function secret | Contact address push services can reach us at. Defaults to `mailto:ops@infinitywindows.app` if unset. |
| `VITE_VAPID_PUBLIC_KEY` | GitHub Actions repo secret | The same public half, handed to the browser. Passed into the build by [`deploy-pages.yml`](.github/workflows/deploy-pages.yml). |

All four are installed already. If they ever have to be replaced, generate a
fresh pair and set both sides in one go, then check that nobody is subscribed
first (`select count(*) from push_subscriptions`) — anyone who is will stop
receiving notifications until their device re-subscribes.

To read the public half that the published app is actually using — useful for a
laptop `.env`, and it needs no credentials because the key is compiled into the
JavaScript we serve:

```bash
SITE=https://infinity-windows.github.io/infinity-windows
curl -s "$SITE/$(curl -s "$SITE/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js')" \
  | grep -oE '[`"]B[A-Za-z0-9_-]{86}[`"]' | tr -d '`"'
```

```bash
npx web-push generate-vapid-keys
gh secret set VITE_VAPID_PUBLIC_KEY --repo Infinity-Windows/infinity-windows
```

Set the three Supabase secrets with `supabase secrets set`, as
[above](#edge-function-secrets) — no dashboard needed.
`VITE_VAPID_PUBLIC_KEY` only takes effect on the next Pages deploy,
because Vite bakes it into the bundle at build time rather than reading it at
runtime.

Without the public key the app does not error — it just quietly never subscribes,
and only in-app notifications work. `send-push` is more direct about it and
returns `{"error":"VAPID keys not configured"}`.

**Two halves that both exist but do not match is the worse failure, and
`Deploy backend` now checks for it.** `scripts/verify-function-secrets.sh` can
only see that `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are *set*; it cannot see
that they are the pair the app was built with. Cross them — by rotating one side,
or by copying a key that was generated against a different Supabase project — and
send-push returns 200, `sent` counts every device, no check goes red, and not one
notification arrives. `scripts/verify-push-key.sh` closes that gap by hashing the
public key the app is built with and comparing it against the digest Supabase
reports for its own `VAPID_PUBLIC_KEY`. It reads no secret and prints neither key
nor digest. To run it by hand:

```bash
SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=czprjcskmzzagdztqonm \
  VITE_VAPID_PUBLIC_KEY=B... scripts/verify-push-key.sh
scripts/verify-push-key.test.sh   # test the checker itself, no credentials
```

**On iPhone and iPad, push only works once the app is installed to the home
screen.** Safari refuses web push to an ordinary browser tab, so an installer who
opens the site in Safari and taps Allow still gets nothing. The app detects this
and shows "Add Infinity to your home screen to get alerts" instead of failing
silently. Android and desktop Chrome need no install. Since the crew are on
phones, the home-screen install is part of setting someone up, not an optional
extra.

### Merging the two Supabase projects

This app was built against two different Supabase projects by two people, and
the data now has to end up in one. [`docs/supabase-merge-plan.md`](docs/supabase-merge-plan.md)
is the plan: which project wins, what order rows have to be inserted in, and
what will go wrong if it is done naively.

The tooling needs an `sbp_…` management token and nothing else:

```bash
SUPABASE_ACCESS_TOKEN=sbp_... scripts/supabase-inventory.sh   # every project on the account
python3 scripts/supabase-compare.py docs/inventory/*.json     # what differs
scripts/supabase-merge.sh --source <a>.json --target <b>.json # dry run, never executes
```

`supabase-merge.sh` has no `--execute`, on purpose — the reasoning is in the
plan.

## Tests

```bash
cd app && npm test                          # 1,313 frontend tests
python3 scripts/test_supabase_merge.py       # 52  merge tooling, stdlib only
python3 scripts/test_schema_verify.py        # 25  post-push schema drift check
python3 scripts/test_function_secrets.py     # 32  which function needs which secret
scripts/verify-functions.test.sh             # 39  the deploy probe, no network
scripts/verify-function-secrets.test.sh      # 59  the secret check, stubbed CLI
scripts/slack-notify.test.sh                 # 57  the failure notifier, posts nothing
```

None of them need credentials or a network. What ships automatically, what
verifies it and what alerts on failure is all written up in
[`docs/always-live.md`](docs/always-live.md).

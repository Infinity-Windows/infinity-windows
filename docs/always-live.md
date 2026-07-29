# Always live: what ships by itself, what proves it, and what shouts

The goal is simple to say and easy to get wrong: **every fix and every addition
should reach the people using the app, automatically, and anything that stops
that should be loud.**

This is the whole pipeline in one place. If you read nothing else, read
[the four things that have to be true](#the-four-things-that-have-to-be-true) and
[the secret inventory](#the-secret-inventory).

## The four things that have to be true

Shipping is not one step, it is four, and each one has failed independently here
in the last month.

| | It has to… | Proven by | Told to a human by |
| --- | --- | --- | --- |
| 1 | **Build** without errors | `CI` (build, lint, 1,313 tests, plus the script test suites) | Slack, on master only |
| 2 | **Reach the servers** — frontend to GitHub Pages, functions and database changes to Supabase | `Deploy GitHub Pages`, `Deploy backend` | Slack |
| 3 | **Actually be there** — functions responding, database really changed, secrets really set | `Verify functions are live`, the schema check, the secret check | Slack |
| 4 | **Reach people's phones** — the running app notices and updates | the build stamp + version check in the app | the "new version" banner |

Every one of those four was, at some point in July 2026, silently untrue while
every build was green.

## What happens when you merge to master

Nothing here is manual. Merging is the whole action.

```
merge to master
├── CI ......................... build, lint, 1,313 frontend tests, script tests
├── Slack changelog ............ posts "Shipped to master" to #infinity-app-changelog
├── Deploy GitHub Pages ........ builds the app, stamps it with the commit sha,
│                                publishes to infinity-windows.github.io
│                                └── phones pick it up (see "Reaching phones")
└── Deploy backend
    ├── Deploy edge functions .. every folder in supabase/functions/
    │   ├── check every required runtime secret exists in Supabase
    │   └── check the app's push key is the one this project signs with
    ├── Push migrations ........ dry run, then supabase db push
    │   └── read the live schema back and check it matches the repo
    └── Verify functions live .. probe every function for a 404
```

If any of that fails, a message goes to **#infinity-app-changelog** naming the
workflow, the change, who pushed it, and a link straight to the failed run.

## Each check, and what it actually proves

The pattern worth noticing: **every one of these was added because the previous
version of it could report success without having verified anything.**

### Build, lint and tests — `.github/workflows/ci.yml`

Runs on every PR and every push to master. `npm run build`, `npm run lint`,
`npm test`, plus the standalone suites for the pipeline's own scripts (they stub
`curl` and the Supabase CLI, so they need no credentials and no network).

### Are the functions live? — `scripts/verify-functions.sh`

An unauthenticated POST at each function. Sorts every one into **deployed**,
**missing** (404) or **undetermined** (no answer at all), and under strict mode
fails on either of the last two. Undetermined counts as failure on purpose: a
probe that got no answer has proved nothing, and treating "could not tell" as
"fine" is how a deploy that shipped nothing went green.

### Do the functions have their secrets? — `scripts/verify-function-secrets.sh`

The gap this closes is nasty because everything looks fine. Runtime secrets live
in **Supabase, not GitHub**, so a function can deploy cleanly, route correctly,
answer the 404 probe above, pass every check in this repo — and return **500 on
every real request** because its key was never set. That is precisely how Ask
Infinity came to answer nothing.

`scripts/function_secrets.py` works out what each function needs **by reading the
sources**, so it cannot rot the way the README's list of "four functions to
deploy" did once there were ten. It follows calls inside each shared module, so
importing `jsonResponse` from the OpenAI helper does *not* count as needing an
OpenAI key, while importing `chatJson` does. An `if (Deno.env.get("X"))` guard
demotes X to optional, because the author is feature-detecting — which is why
`ask` is listed as not requiring an OpenAI key: without one it skips retrieval
and answers from live data.

```bash
python3 scripts/function_secrets.py    # no credentials needed
```

### Can a notification actually be delivered? — `scripts/verify-push-key.sh`

The check above proves the two push keys **exist**. It cannot prove they are the
matching pair, and that distinction is the whole failure. Web push works only
when the public half the browser subscribed with belongs to the private half
`send-push` signs with. Cross them and `send-push` returns 200, reports every
device as sent, nothing 500s, nothing goes red — and no notification lands on
anyone's phone, ever.

It happened. A pair generated on 2026-07-20 against `jvsyhtarnvmdilsgksdi` was
still sitting in a laptop `app/.env` that had been repointed at
`czprjcskmzzagdztqonm`. Push on that laptop could never have worked, and no check
in this repo could see it.

`supabase secrets list` prints a **SHA-256 digest** of each value, never the
value. So the check hashes the public key the app is built with — public by
design, and already readable in the published bundle — and compares it against
the digest the platform reports. It reads no secret and prints neither key nor
digest.

The one thing that fails it is a genuine mismatch. An app built with **no** push
key is reported and passes, because that is a different problem (nobody
subscribes at all) and putting two causes behind one headline is how a check
stops being read. Anything it could not measure — no answer from the CLI, an
unreadable digest — fails, for the same reason an unanswered function probe does.

### Did the database really change? — `scripts/verify-schema.sh`

`supabase db push` exiting 0 proves the CLI ran. It does not prove the schema is
right: on 2026-07-29 production was **26 of 68 declared tables short** with every
build green. So after the push, the live catalog is read back and compared with
what the migration files declare.

**The comparison is deliberately one-way.** This is the most important design
decision in this document:

- **Declared in the repo, missing from the database → the deploy FAILS.** A
  migration did not apply, so code that uses that table or column is broken in
  production right now.
- **In the database, declared by no migration → reported, never fails.**

Blocking is scoped to **tables and columns**, which is unambiguous here: nothing
in `supabase/migrations/` drops or renames one, so declared-and-absent can only
mean "did not apply". Constraints, triggers, functions, policies and indexes are
written as drop-then-recreate pairs and the extractor is a scanner rather than a
full SQL parser, so a missing verdict on those is not trustworthy enough to stop
a deploy — they are listed in the job summary instead.

It measures **objects, never migration bookkeeping.** Production's
`supabase_migrations.schema_migrations` holds 37 phantom version rows (see
[`db-push-readiness.md`](./db-push-readiness.md)), and trusting recorded history
is exactly what let an earlier audit certify the wrong database. Nothing in the
check reads a `migration|` row.

#### `project_marks` — a known undeclared table

**`project_marks` exists in production (`czprjcskmzzagdztqonm`) and no migration
file declares it.** It needs a migration written for it, and that has not been
done here on purpose: reverse-engineering a live table's exact columns, types,
constraints and policies without database access would be guesswork, and a wrong
guess committed as a migration is worse than the gap.

Until then:

- A fresh Supabase project **cannot** be rebuilt from this repo. It would come up
  without `project_marks`, and anything using it would break.
- Every backend deploy reports it — job summary plus a **warning** (not a failure)
  in Slack naming the table.
- There may be more like it. The check names whatever it finds; it is not a list
  of one.

Why it is reported rather than blocked: making the deploy red on every single
merge because of a table nobody can currently write a migration for would teach
everyone to ignore the job. This repo has already lost three checks that way in a
week. There is **no allowlist** — no hand-maintained set of tolerated exceptions
to rot. The direction of the check is what makes `project_marks` non-fatal, so
nothing needs updating when the migration finally lands: it simply stops being
reported.

To write that migration, someone with access should dump the real definition
(`scripts/pgq.sh` is read-only and refuses to guess which project it is talking
to) and commit it as a normal migration file.

### Do people actually have it? — the build stamp

See below. This is the fourth step, and the one that used to be invisible.

## Reaching phones

Installers run this as an installed PWA. A service worker serves the app shell
from its own cache, which is what makes the app work in a dead zone — and also
what lets a phone keep running an old build after a new one has shipped.

### How long a phone used to take to pick up a new build

**Before this change: anywhere from about an hour to indefinitely.** Not a
guess — it follows from what the code did.

The app registered the worker with `registerType: 'prompt'` and asked the browser
to check for a new one on a `setInterval` of **one hour**. That was the only
trigger. So:

- **Best case, app open and in the foreground the whole time: up to an hour**,
  then the "new version available" banner appears and the user has to tap
  Refresh. Nothing happened without that tap.
- **Realistically, a phone in a pocket: indefinitely.** Background timers are
  throttled and then suspended in a backgrounded PWA, hard on iOS. The hourly
  timer simply does not fire, so a phone that spends the day switching between
  apps might never check at all.
- **Force-quitting and relaunching** did check on startup, which is why "close it
  and open it again" appeared to fix things — and why a collaborator who did not
  know that sat on an old build for hours.

The stale cache incident that produced `app/src/lib/serviceWorkerGuard.ts` was
the same root cause. That guard only runs in development (`import.meta.env.DEV`),
so it did nothing for this on a real phone.

### What happens now

1. Each build is stamped with the commit sha (`VITE_BUILD_ID` in
   `deploy-pages.yml`), compiled into the bundle and written to
   `dist/version.json`. Both come from one value in `vite.config.ts`, so they
   cannot disagree — if they could, the app would think an update existed forever.
2. `version.json` is **not** precached (the worker's glob patterns cover
   js/css/html/images/fonts, not json) and is fetched with `cache: "no-store"`,
   so the answer is always current. A precached version file would report its own
   build forever, which is the trap this is escaping.
3. The app checks every 5 minutes **and the moment it comes back into view**.
   Returning to the app is now enough to notice a new build, which is the case the
   hourly timer could never cover.
4. Finding a newer build triggers the service-worker update, which downloads the
   new bundle and leaves it waiting.
5. Once it is waiting, the app decides between applying it and asking.

**Expected time to reach a phone now: a few minutes if the app is open, or
essentially immediately on the next time someone looks at their phone.**

### When it reloads by itself, and when it asks

| Situation | What happens |
| --- | --- |
| Unsaved work in progress | **Asks.** Never reloads. No exceptions. |
| Nothing unsaved, app was out of sight ≥ 60s | **Reloads itself.** The user comes back to the new version. |
| Nothing unsaved, app in active use | **Asks.** |

The rule that unsaved work always wins is not caution for its own sake. Reading
`OpeningSheet.tsx` and `installOutbox.ts`: an install is written to IndexedDB
**only at submit**, at which point the outbox makes it durable and survives
anything. Before that, the voice memo, the before/after photos and the video are
in-memory blobs in React state and exist **nowhere else**. A reload at that
moment destroys camera captures that cannot be retaken — the opening may already
be closed up. Being one build behind for a few minutes costs nothing by
comparison.

`lib/pwa/unsavedWork.ts` is a claim count rather than a flag, so two screens can
hold work at once and the first to finish cannot clear the other's claim. The
screens that claim are `OpeningSheet` (any capture started) and `PlansetUpload`
(an extraction running). The decision itself is a pure function in
`lib/pwa/updateCore.ts` with 44 tests, including that a long absence never
overrides unsaved work.

One subtlety worth knowing: a plain `location.reload()` would **not** help. The
old worker still controls the page and would serve the same cached shell straight
back. The update goes through `updateServiceWorker(true)`, which tells the
waiting worker to take over first.

## When something breaks

Every workflow posts to **#infinity-app-changelog** on failure, via one reusable
workflow (`.github/workflows/notify-failure.yml`) rather than the same block
copied into five files. The message says which workflow, the commit and its
message, who pushed it, and a direct link to the failed run.

Three properties it is built to have:

- **Failure only.** Successes already have the changelog post.
- **It cannot fail the build.** `scripts/slack-notify.sh` swallows every error and
  always exits 0. A notifier that breaks the build it is reporting on would be
  worse than none.
- **It degrades quietly.** No `SLACK_CHANGELOG_WEBHOOK`, no jq, an unreachable
  webhook — all log a line and stay green.
- **It leads with the cause, not the workflow name.** When the failing job can say
  what actually went wrong it passes a one-line `cause`, and that becomes the first
  line of the post: *"Ask Infinity and plan-set reading need an API key that has
  not been added yet"*, with `Deploy backend` demoted to the line below. A reader
  who is told only "Deploy backend FAILED" learns to worry and nothing else. Jobs
  that cannot name a cause fall back to the workflow-name header.

**CI failures on a pull request are deliberately not posted.** Whoever opened it
can see the red mark, and posting every red PR into a channel read by
non-technical people would train them to ignore it. A failure on **master** is
different: that is what everyone is running, and nobody is necessarily watching.

The job this was built for is `Vault brain sync`, which runs at 08:00 UTC with
nobody watching and had been failing for about a week before anyone noticed.

## The secret inventory

Two different places, and mixing them up is a recurring source of confusion.

### GitHub — repo secrets

Settings → Secrets and variables → Actions. These let the pipeline *do* things.

| Secret | Used by | What breaks without it |
| --- | --- | --- |
| `SUPABASE_ACCESS_TOKEN` | `Deploy backend` | Edge functions are never deployed, and neither the schema check nor the secret check can run. Jobs **skip with a warning** rather than failing. A personal access token, `sbp_…`. |
| `SUPABASE_DB_PASSWORD` | `Deploy backend` | Migrations are never pushed, so the database silently stops tracking the code. Skips with a warning. |
| `SUPABASE_SERVICE_ROLE_KEY` | `Vault brain sync` | The nightly Obsidian vault mirror fails. This one **does** fail loudly. |
| `SLACK_CHANGELOG_WEBHOOK` | `Slack changelog`, every failure notification | No changelog posts and no failure alerts. Everything degrades quietly, which means **failures go back to being silent** — the exact problem this pipeline was built to fix. |
| `VITE_SUPABASE_URL` | `Deploy GitHub Pages` | The published app cannot reach the database at all. |
| `VITE_SUPABASE_ANON_KEY` | `Deploy GitHub Pages` | Same. (Not really a secret — it is compiled into public JavaScript, and row-level security is what protects the data.) |
| `VITE_VAPID_PUBLIC_KEY` | `Deploy GitHub Pages` | No phone ever subscribes to notifications, silently. Also not really a secret — it is the public half of the push pair and is readable in the published bundle. It must be the public half of the pair whose private half is in Supabase; `scripts/verify-push-key.sh` is what proves that. |

Install one:

```bash
gh secret set SUPABASE_ACCESS_TOKEN --repo Infinity-Windows/infinity-windows
```

The command prompts and does not echo, so nothing lands in shell history or git.

### Supabase — Edge Function secrets

These are what make deployed functions *work*. Full table, and the
`supabase secrets set` commands, are in
[the README](../README.md#edge-function-secrets). In short:

| Secret | Needed by | What breaks without it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `ask`, `extract-specs` | Ask Infinity answers nothing; reading specs off a planset fails. |
| `OPENAI_API_KEY` | 6 functions | Voice memos are never transcribed; how-tos and toolbox talks cannot be generated; nothing new reaches the brain. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `send-push` | Push notifications silently stop. |

Optional, with working defaults: `ANTHROPIC_MODEL`, `VAPID_SUBJECT`.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
by the platform into every function. Do not set them by hand.

### Why the backend jobs skip instead of failing

Until `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` exist, the backend jobs
annotate the run with what they would have done and pass. That is deliberate and
has been settled twice: a repo where the build is red for a reason nobody can fix
today is a repo where red stops meaning anything. Once the secrets exist, the
same jobs become strict — a function still 404ing after a deploy, a missing
secret, or a schema that does not match all fail the run.

## The first real run will be red, on purpose

Read this before looking at Actions, because a red mark is alarming and this one
is not a breakage.

`SUPABASE_ACCESS_TOKEN` now exists in GitHub, so the secret check runs for real.
`ANTHROPIC_API_KEY` has never been set in Supabase, and it is the only thing
missing anywhere. So the first `Deploy backend` after this lands will fail with
exactly one cause:

> Ask Infinity and plan-set reading need an API key that has not been added yet

That is not a regression. Those two features have been failing at runtime this
whole time — the only new thing is that the pipeline now says so out loud instead
of shipping green over the top of it. Everything else in that run succeeds: the
functions deploy, and the frontend ships from its own workflow regardless.

The fix is one field: Supabase dashboard → the project → **Project Settings →
Edge Functions → Secrets** → add `ANTHROPIC_API_KEY`. Then Actions → Deploy
backend → Run workflow. Nothing needs redeploying; the functions read the key on
their next request.

`SUPABASE_DB_PASSWORD` is still deliberately absent, so the migrations job and the
schema check **skip** with a warning rather than failing.

### What the check will not complain about

The value of a check is destroyed the first time it cries wolf, so this one is
narrow on purpose:

- **Optional variables are never reported.** `ANTHROPIC_MODEL` and `VAPID_SUBJECT`
  have working defaults in the function source (`?? "some-default"`), so a missing
  one changes nothing at runtime. `scripts/function_secrets.py` reads that pattern
  out of the code and classifies them as optional.
- **Platform-injected variables are never reported.** `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are supplied by Supabase to
  every function. Asking a human to set them would be asking for the impossible.
- **Anything already set is not reported.** `OPENAI_API_KEY` and all three VAPID
  keys are present, so they appear as `set`.

Both of those exclusions are pinned by tests in
`scripts/verify-function-secrets.test.sh`, against a stub of the CLI output that
matches the live project exactly.

## Turning it all on

Order matters slightly. The runbook for the database part, including the phantom
migration rows that must be cleared before the first real push, is
[`db-push-readiness.md`](./db-push-readiness.md).

1. ~~`gh secret set SUPABASE_ACCESS_TOKEN`~~ — **done.** Edge functions deploy, and
   the secret check is live.
2. Add `ANTHROPIC_API_KEY` in the Supabase dashboard under **Project Settings →
   Edge Functions → Secrets**. This is the one thing standing between the pipeline
   and green — see [the section above](#the-first-real-run-will-be-red-on-purpose).
3. Run `scripts/cleanup-migration-phantoms.sh` (preview, then `--execute`).
4. `gh secret set SUPABASE_DB_PASSWORD` — migrations start pushing, and the schema
   check comes alive.
5. Actions → **Deploy backend** → Run workflow, and watch it go green.
6. Write a migration for `project_marks` so a fresh database can be rebuilt from
   this repo.

## Where each piece lives

| | |
| --- | --- |
| `.github/workflows/ci.yml` | build, lint, tests, script test suites |
| `.github/workflows/deploy-pages.yml` | frontend to GitHub Pages, stamps the build |
| `.github/workflows/deploy-backend.yml` | functions, migrations, and their verification |
| `.github/workflows/vault-sync.yml` | nightly Obsidian vault mirror |
| `.github/workflows/slack-changelog.yml` | plain-English record of every change |
| `.github/workflows/notify-failure.yml` | the one failure notifier everything calls |
| `scripts/slack-notify.sh` | builds and posts the message; can never fail |
| `scripts/verify-functions.sh` | are the functions live? |
| `scripts/verify-function-secrets.sh` | do they have their keys? |
| `scripts/verify-push-key.sh` | is the app's push key the one the server signs with? |
| `scripts/function_secrets.py` | which function needs which key, read from source |
| `scripts/verify-schema.sh` | did the database really change? |
| `scripts/schema_verify.py` | the directional comparison, and why it is directional |
| `scripts/pgq.sh` | read-only query helper; refuses to guess a project |
| `app/src/lib/pwa/updateCore.ts` | reload-or-ask decision, and the reasoning |
| `app/src/lib/pwa/unsavedWork.ts` | what must never be reloaded over |
| `app/vite.config.ts` | the build stamp and `version.json` |

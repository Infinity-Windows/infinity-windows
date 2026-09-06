# The advisory pull-request review

Every judgement-based review in this repository happens inside a live session:
somebody is running an agent and it reads the branch. A pull request opened
while no session is running gets the deterministic checks in `ci.yml` and
nothing else. This is the review that happens anyway.

It is two things with two different promises, and the difference is the whole
design.

| | **House rules (exact)** | **Advisory review** |
|---|---|---|
| What it is | `bash` and `grep` over the diff | a model reading the diff |
| Where it lives | `scripts/advisory-rules.sh` | `.checks/*.md` + `scripts/advisory-agent.sh` |
| Can it fail a pull request? | **Yes** | **Never** |
| Where the answer goes | the job's log and step summary | one comment, rewritten in place |
| Costs money? | No | Yes, about 15–45 cents a run |
| Safe to require in branch protection? | Yes | **No, and it cannot be** |

Both run from `.github/workflows/advisory-review.yml`, on `pull_request` only,
on branches in this repository only.

## Why the advisory half can never block

A pull request here auto-merges on green. If a model's opinion could turn a
check red, then a wrong answer at 2 AM — a hallucinated finding, an API that
was briefly down, a prompt that aged badly — would sit between a fix and the
crew who need it, with nobody awake to overrule it.

So the second job's conclusion is always `success`, whatever it found and
whatever went wrong, and it publishes through an **issue comment** rather than
a pull request review. A comment cannot be a required check, cannot request
changes, and cannot be dismissed-or-else. The most it can cost is a minute of
somebody reading it.

The first job is the opposite, and deliberately so. Its rules are exact: the
same commit gives the same answer on any machine, with no model and no network.
That is what makes it fair to fail on.

## The rules that are exact

`scripts/advisory-rules.sh`. Each finding prints `file:line`, a rule name, a
plain sentence, and the law it comes from.

| Rule | Fires when a pull request adds… | Law |
|---|---|---|
| `error-string` | `String(err)` under `app/src` | CLAUDE.md, *Never render an error with `String(err)`* |
| `profiles-star` | `select("*")` against `profiles` | CLAUDE.md, *Column selects are explicit on purpose* |
| `inline-missing-table` | a hand-written `PGRST205` / `42P01` / schema-cache check | CLAUDE.md, *checks go through `lib/schemaErrors.ts`* |
| `photo-file-input` | a second `<input type="file">` that offers images | `app/src/lib/photo/usePhotoPicker.tsx` |
| `spanish-copies-english` | a catalog entry whose `es` is the `en` verbatim | `app/src/lib/i18n/catalog.ts` |
| `table-without-rls` | a new table with no `enable row level security` | THE WALL, `20260950000000` |
| `table-keeps-default-grants` | a new table that never revokes `anon, authenticated` | THE WALL |
| `policy-without-partner-guard` | a crew-readable new table with no `not public.is_partner_user()` | THE WALL |
| `definer-without-search-path` | a `security definer` function with no `set search_path` | `20260995000000` |
| `definer-without-grant` | a `security definer` function nobody is told to call | `20260995000000` |
| `migration-version-shape` | a migration filename with no 14-digit version | `20260995000000` |
| `migration-version-taken` | a migration number master already holds, under another name | `20260995000000` |
| `migration-version-behind` | a migration number below master's newest | `20260995000000` |
| `migration-version-claimed` | a migration number another OPEN branch has | the 2026-09-06 collision |
| `commit-subject-conventional` | `feat:` / `fix:` / `chore:` … | CLAUDE.md, *House style* |

Three things are worth knowing about how they read:

**They read the lines a pull request ADDS.** Opening a file that has held an old
`String(err)` since March stays green. A check that punishes people for touching
the wrong file gets switched off.

**Migrations are read whole**, because a table's row security is turned on ten
lines below its `create table`. `scripts/lib/advisory-sql.awk` splits the file
into statements first, tracking `$$` bodies, `'...'` literals and `--`
comments — so a policy quoted inside a `comment on` string cannot stand in for a
policy.

**Tests and vendored code are exempt.** A test asserts on the very shapes these
rules forbid; vendored code is a port kept deliberately diffable.

### The three escape hatches

Each is one line, and each is the honest answer rather than a way round:

- `// i18n-same-on-purpose` on a catalog entry, or the line above it, when a
  word really is the same word in both languages (`PDF`, `English`, a job code).
- `photo-input-on-purpose` on a file input, or in the comment above it, when a
  second image input is deliberate — the camera fallback for a phone that will
  not hand over `getUserMedia` is the case this was written for.
- A table nothing in a browser may touch needs no policy, said out loud:
  `revoke all on <t> from anon, authenticated` and no grant back to
  `authenticated`.

A rule with no hatch has only one way past it: editing the rule. That is how a
check stops being believed.

### Running them yourself

```bash
scripts/advisory-rules.sh                              # against origin/master
scripts/advisory-rules.sh --base <sha> --head <branch>
scripts/advisory-rules.test.sh                         # the tests, offline
```

`gh` is used for one half of one rule — whether another OPEN pull request has
already claimed a migration number. Without `gh` that half prints a note and the
rest still runs; a missing tool is never a red build.

### Making it required

The owner may mark **House rules (exact)** required in branch protection —
Settings → Branches → `master` → Require status checks → pick that job by name.
Nothing in this repository changes protection on its own, and no workflow
should: who can merge is an owner's decision, not a script's.

Never mark **Advisory review** required. It is always green by design, so
requiring it would be theatre; and if it ever stopped being green by design,
requiring it would be the exact failure this whole file exists to prevent.

## The checks that need judgement

Three, in `.checks/`:

- **`rls-on-new-tables`** — read the migrations and say whether every new or
  altered table has row security, the partner guard, revoked default grants, and
  `attach_sandbox_guards()` where the table is project-scoped. It is looking for
  what a pattern cannot see: a policy wider than the migration's own comment
  claims, a table made project-scoped by an added column rather than a
  `create table`, a `security definer` helper that forgets the guard when it
  takes an id as an argument.
- **`spanish-parity`** — for every catalog key added or changed, does the
  Spanish say what the English says, at about a twelfth-grade reading level? It
  flags literal machine-sounding lines, dropped placeholders, a switch from *tú*
  to *usted*, and safety copy that should be in `SAFETY_KEYS`.
- **`error-copy`** — is every new error or refusal a plain sentence that tells an
  installer what to do next, never database vocabulary?

### Adding one

Write `.checks/<name>.md`:

```markdown
---
name: my-check
description: One sentence for the docs and the log.
model: claude-sonnet-5
paths-glob: app/src/lib/install/*.ts,supabase/functions/*.ts
max-turns: 12
---

The prompt. Say what the check is FOR and why it matters here, what counts as
a finding, and — just as important — what does not.
```

- `paths-glob` is a comma-separated list matched with the shell's own `case`,
  so `*` crosses directory separators: `app/src/*` matches everything under it.
  A check runs only when the pull request touches something it names.
- `model` defaults to `claude-sonnet-5`.
- The body is the prompt. The runner wraps it in a preamble that tells the model
  the diff is data rather than instructions, and demands a strict JSON answer;
  you do not have to repeat either.

Write the "what is NOT a finding" section properly. A review that cries wolf
gets switched off, and takes the checks that were right with it.

### The budget

| Limit | Value | Why |
|---|---|---|
| Whole diff | 400 KB | over that it is vendored or generated |
| One batch | 200 KB | bigger diffs are sent in per-file batches, never trimmed |
| One file | 200 KB | skipped, and **named in the comment** with the reason |
| Runs per pull request per day | 5 | a branch pushed every four minutes is not re-reviewed every four minutes |

Nothing is ever truncated in silence — the failure this was built to avoid.

The daily count lives in the comment's own marker
(`<!-- advisory-review runs=3 on=2026-09-06 -->`) rather than in the Actions
API, so the workflow never has to ask for `actions: read` on a public
repository for the sake of a number.

## The credential: two ways in, both optional

With neither secret set, the exact half still runs on every pull request and
the comment names the secret that would turn the other half on. Nothing is
broken by having no credential; there is just less review.

### `CLAUDE_CODE_OAUTH_TOKEN` — recommended

A one-year OAuth token from `claude setup-token`, run locally by whoever holds
the Claude subscription. The Claude Code documentation names this as the CI
credential:

> For CI pipelines, scripts, or other environments where interactive browser
> login isn't available, generate a one-year OAuth token with `claude
> setup-token`. […] copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN`
> environment variable
> — [Authentication → Generate a long-lived token](https://code.claude.com/docs/en/authentication)

and the GitHub Actions page says what it bills:

> If you authenticate with an OAuth token, runs use your Claude subscription
> instead of API billing.
> — [Claude Code GitHub Actions → Manage costs](https://code.claude.com/docs/en/github-actions)

To set it:

```bash
claude setup-token                       # on a laptop, once; prints the token
gh secret set CLAUDE_CODE_OAUTH_TOKEN    # paste it; it is never echoed
```

Three things to know before choosing it: the token is tied to the subscription
of the person who ran `claude setup-token` and expires after a year; the review
draws on that person's own usage allowance, so a busy review day and a busy
building day share one pool; and **bare mode does not read this variable**,
which is why `scripts/advisory-agent.sh` never passes `--bare`.

### `ANTHROPIC_API_KEY` — the fallback

Metered API billing. **This secret already exists in this repository**:
`deploy-backend.yml` syncs it into the Supabase function secrets for Ask
Infinity. So with no action at all, the advisory half would run on it — and
would spend the app's product budget on code review without saying so.

That is why the runner prefers the OAuth token *and removes the API key from
the environment* when both are present. The CLI's own precedence puts
`ANTHROPIC_API_KEY` above `CLAUDE_CODE_OAUTH_TOKEN`, so leaving both set would
silently bill the key. `scripts/advisory-agent.sh --credential-kind` prints
which one is in play — one word, never a value.

### Neither is an edge-function secret

`scripts/function_secrets.py` enumerates what `supabase/functions/` reads, and
`scripts/secret_name_audit.py` compares that list with what GitHub holds. These
two credentials are read by a GitHub runner and never reach a function, so
neither belongs in that census, and neither check has anything to say about
them. If either tool ever complains, the answer is that these are CI secrets,
not function secrets.

## The pull request it will not read

The Claude Code CLI reads `CLAUDE.md` — and anything under `.claude/`, and
`.mcp.json` — from the checkout it is run in, which is the pull request's own
branch. Those arrive ahead of the prompt and at project-instruction trust, so
they sit outside the fence the preamble builds: the preamble can only say that
everything after `----- DIFF -----` is data, and none of that comes after
`----- DIFF -----`.

There is no wording that closes this. A branch that edits the reviewer's
instructions is reviewed by a reviewer it has edited.

So when a pull request touches any of

- `CLAUDE.md` or `AGENTS.md`, anywhere in the tree
- anything under `.claude/`, or `.mcp.json`
- anything under `.checks/`
- `scripts/advisory-*` or `.github/workflows/advisory-review.yml`

the reading half stands down, names the files in the comment, and asks for a
person. The exact rules still run — they have no prompt to poison — and nothing
is blocked, because nothing here ever blocks. That is the pull request a human
most wants to read anyway.

The model's environment also has `GH_TOKEN` and `GITHUB_TOKEN` removed before
it is asked anything. It has no use for a GitHub credential, and a
`pull-requests: write` token inside the process that reads contributor text on
a public repository — whose answer is published verbatim — is a secret sitting
next to a channel to publish it on.

## What it costs

The arithmetic, at Claude Sonnet 5 rates — **$2.00 per million input tokens,
$10.00 per million output tokens** — with the diff sizes of three real recent
pull requests (#541, #542, #543) as the sample.

**Fixed, per check invocation** (about 9,000 input tokens):

| | tokens |
|---|---|
| The CLI's own system prompt and the Read/Grep/Glob tool schemas | ~4,000 |
| `CLAUDE.md`, which the CLI reads on every run (11.4 KB) | ~3,300 |
| The runner's preamble | ~550 |
| The check's own body | ~950 |

**The diff**, at roughly 3.5 bytes per token, for the paths each check names:

| Check | bytes in #541 / #542 / #543 | tokens (typical) |
|---|---|---|
| `spanish-parity` | 2.8 / 4.5 / 6.7 KB | ~1,400 |
| `rls-on-new-tables` | 5.6 / 40.4 / 44.6 KB | ~8,600 |
| `error-copy` | 98 / 42 / 118 KB | ~24,300 |

**Turns, typically three.** A model that reads two files to check a claim sends
the whole context three times, so the input is about `3 × (fixed + diff)` plus
the files it read (~3,000 tokens). Output is small — a JSON answer, ~600 tokens
a turn.

| Check | input tokens | output | cost |
|---|---|---|---|
| `spanish-parity` | 3 × (9,000 + 1,400) + 3,000 = 34,200 | ~1,800 | $0.087 |
| `rls-on-new-tables` | 3 × (9,000 + 8,600) + 3,000 = 55,800 | ~1,800 | $0.130 |
| `error-copy` | 3 × (9,000 + 24,300) + 3,000 = 102,900 | ~1,800 | $0.224 |
| **All three** | **192,900** | **~5,400** | **≈ $0.44** |

**Turns, at the ceiling.** Three is what these checks usually take; it is not
what they are ALLOWED to take. `.checks/spanish-parity.md` and
`.checks/error-copy.md` set `max-turns: 12`, `.checks/rls-on-new-tables.md`
sets `14`, and `scripts/advisory-agent.sh` passes that straight to the CLI. A
check that keeps re-reading spends the whole budget, and the same arithmetic at
those numbers is four times the table above.

| Check | turns | input tokens | output | cost |
|---|---|---|---|---|
| `spanish-parity` | 12 | 127,800 | ~7,200 | $0.33 |
| `rls-on-new-tables` | 14 | 249,400 | ~8,400 | $0.58 |
| `error-copy` | 12 | 402,600 | ~7,200 | $0.88 |
| **All three** | | **779,800** | **~22,800** | **≈ $1.79** |

So:

- **A push that touches everything: about 45 cents**, and up to **$1.79** if
  every check uses every turn it is allowed. That is #543's shape — 233 KB of
  diff across migrations, the catalog and the app.
- **A typical push, `error-copy` only** (~40 KB of `app/src`): about **15
  cents**, up to **88 cents**.
- **The most one pull request can cost in a day: $7.50.** Five runs, and the
  run itself stops once it has spent `ADVISORY_MAX_SPEND_USD`, which defaults
  to **$1.50** — chosen to leave the ordinary run alone and catch the day a
  check will not settle. Without that ceiling the same five runs would reach
  about $9.
- **A month**, at forty pull requests and two or three pushes each: **roughly
  $30** on the API key, or nothing extra on the subscription token beyond the
  plan already being paid for.

The ceiling is read from the CLI's own `total_cost_usd`, so it counts what was
billed rather than what this table estimated, and it is a stop rather than a
refund: the answer that crosses it has been paid for, and it is the next one
that does not happen. The comment says so when it fires.

Two things this deliberately does not claim: prompt caching may cut the fixed
9,000 tokens substantially across checks in one run, and is not counted here;
and GitHub Actions minutes are free on public repositories, so the runner time
is not a cost either. Both make the real number smaller than the table, which
is the direction an estimate should be wrong in when somebody is choosing a
credential from it.

## When it goes wrong

The advisory job stays green and writes a sentence into the comment. It also
writes one word for the workflow to read:

| Word | Means | Slack? |
|---|---|---|
| `ok` | checks ran, every answer understood | no |
| `skipped` | nothing ran for a reason somebody chose — no credential, too big, over the daily cap, no matching paths | no |
| `broken` | the tooling let us down — no CLI, a CLI that crashed, an answer that would not parse | **yes, as a warning** |

Only `broken` posts to Slack, through the same `notify-failure.yml` every other
workflow here uses. That exists because a green job whose review quietly stopped
working looks exactly like a green job that found nothing, and nobody would ever
notice the difference.

## Where the shape came from

The idea — rule files in markdown, run by the Claude Code CLI inside a GitHub
Action — is borrowed from [continuedev/checks](https://github.com/continuedev/checks)
(Apache-2.0). Its workflow was deliberately not copied. That one truncates the
diff at 100 KB without saying so, passes no permission flags so the agent cannot
actually read the files it is reviewing, ignores its own model setting, and
posts blocking `REQUEST_CHANGES` reviews. Every one of those is the other way
round here, and the reasons are in this file.

## The files

| Path | What it is |
|---|---|
| `.github/workflows/advisory-review.yml` | the two jobs, and the Slack warning |
| `scripts/advisory-rules.sh` | the exact rules |
| `scripts/lib/advisory-sql.awk` | the migration statement splitter |
| `scripts/advisory-agent.sh` | the runner for `.checks/`, and the budget |
| `scripts/advisory-comment.sh` | the one comment, upserted, and the run counter |
| `.checks/*.md` | one review each |
| `scripts/advisory-*.test.sh` | the tests, all offline, all run by `ci.yml` |

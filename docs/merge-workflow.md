# How changes get merged (and why nothing can quietly break master)

This is the answer to a real complaint: *"when we go to push new changes, right
before they get pushed they need audited against what's live. Sometimes me and
Ammon are pushing simultaneously... I feel very inefficient."*

Both halves of that are now handled: master is protected so a broken change
cannot land, and nobody has to hand-check anything before merging.

---

## What changes for you day to day

**Taylor:** nothing new to learn, and one thing to stop doing. Tell your agent
what you want, it opens a pull request, and it turns on **auto-merge**. From then
on the change lands by itself the moment the tests go green — you don't have to
watch it, click anything, or come back later. If you'd rather look first, open
the link and read it; the merge still happens on its own once it's green.

**Ammon:** same thing, and you no longer need to think about whether Taylor is
mid-merge. Open your PR, let auto-merge handle it, move on. You will never be
asked to "update your branch", rebase, or re-run anything by hand.

**When you both click merge at the same moment:** nothing bad happens, and
neither of you has to do anything. GitHub merges them one at a time in the order
they became ready — it physically cannot apply two merges at once. The second one
does **not** get rejected and does **not** need updating; it just lands a few
seconds later. Deploys are already queued one-behind-the-other too, so the site
and backend never get two overlapping updates.

**When a change is refused:** the PR simply won't merge, and it says why —
almost always "the build or tests failed." Nobody needs to fix git. Paste the
message to your agent and say "this PR is blocked, fix it." The agent pushes a
fix and, because auto-merge is still armed, the PR lands on its own once green.
You never have to re-merge it.

---

## The real risk this protects against

Git already catches the obvious kind of clash: two people editing the same lines.
It stops and says CONFLICT, loudly.

The dangerous kind is the one git cannot see. Two changes are each perfectly fine
on their own, both pass their tests, and they are broken *together* — one renames
something the other still calls by its old name. Each was tested against a
version of master that no longer existed by the time it landed. Nothing ever went
red, and yet master is broken. Today about eighteen changes merged in a single
hour from several agents plus a human, so this is a live risk, not a theory.

Two things now guard against it: no change can merge unless its own build and
tests pass, and master itself is rebuilt on every merge, so if a combination
does break, it goes red within about a minute and Slack says so.

---

## What is actually configured

A repository ruleset named **"master: audit every change against live"**
(`.github/rulesets/master.json` in this repo, so it isn't invisible dashboard
state). On `master` it:

- **Requires a pull request.** Nothing can be pushed straight to master, by a
  person or by an agent.
- **Requires these three checks to pass**, and nothing else:
  - `Build, lint & test`
  - `Deploy-verification script tests`
  - `Supabase merge tooling`
- **Allows squash merging only**, which is how everything has been merged.
- **Blocks force-pushing and deleting master.**
- **Does not require an approving review** (see below).

The committed file is the exact payload GitHub was given, so the rules can be
reviewed in a PR and put back if they're ever changed by hand:

```bash
gh api -X PUT repos/Infinity-Windows/infinity-windows/rulesets/19997293 \
  --input .github/rulesets/master.json
```

### Why only those three checks

Those three are the only ones that run *on a pull request* and report a real
pass/fail. They all come from `ci.yml`.

Deliberately **not** required:

- Anything from `deploy-backend.yml` or `deploy-pages.yml`. Those run *after* a
  merge, on master — never on a PR. Requiring one would mean waiting forever for
  a check that never reports.
- **`Deploy backend` in particular is failing on purpose right now**, because a
  deliberate check reports a missing `ANTHROPIC_API_KEY`. Had it been required,
  nothing in this repository would ever have been mergeable again. It is not
  required, and this was tested: every change merged while master was red on
  `Deploy backend`.
- The Slack notifier jobs and `proposed`/`shipped`. They are skipped on most
  runs, so they never report a pass.

### Why no review requirement

This is a deliberate choice, not an oversight. There are two people and a fleet
of agents merging many changes an hour. Requiring a human approval on every one
would stall the whole thing, and there is nobody spare to approve them. Safety
here comes from tests that actually run, not from a rubber-stamp click.

---

## Why there's no merge queue (and what we did instead)

The ideal tool for this is GitHub's **merge queue**: it tests each change against
the true latest master at the moment of merging, automatically. We cannot have
it. Merge queue is only available for private repositories on **GitHub Enterprise
Cloud**; this organisation is on **Team**. GitHub's own documentation says so —
"Pull request merge queues are available in any public repository owned by an
organization, or in private repositories owned by organizations using GitHub
Enterprise Cloud" ([managing a merge
queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).

This was confirmed against the live repository, not just read: adding a
`merge_queue` rule to the ruleset is rejected with `Invalid rule 'merge_queue'`,
while the identical request without that one rule succeeds; and the field that
would switch it on doesn't exist in GitHub's API for this account at all.

So we use the closest workable substitute: **auto-merge**, plus required checks.

### The one real trade-off, made on purpose

GitHub can also require that a branch be **fully up to date with master before
merging**. That sounds strictly safer, and we tried it first. It is a trap
without a merge queue: master moves every few minutes here, so nearly every PR
immediately becomes "behind" and stops. Auto-merge does **not** rescue it —
tested for four and a half minutes on a real PR with auto-merge on: it sat there
untouched. Someone has to hand-update every single PR and wait for a full
re-test. That is exactly the inefficiency we were asked to remove, and it makes
the repo's safety depend on a person doing tedious work every time.

So that setting is **off**. A change is tested on its own merits and merges
promptly, which may mean it was tested against a master that is a few minutes
old. In exchange, nobody ever hand-updates a branch. The gap is covered by the
fact that master is rebuilt on every merge and Slack shouts within a minute if a
combination breaks it.

Plain version: we chose *"catch it within a minute, with zero manual work"* over
*"prevent it, at the cost of someone babysitting every merge forever."*

If this repository ever moves to GitHub Enterprise Cloud, turn on the merge queue
and this trade-off disappears.

---

## Deploys were already safe

Both `deploy-backend.yml` and `deploy-pages.yml` already have concurrency groups,
so two deploys cannot run over each other — they queue. Nothing about deploys was
changed.

---

## Master is currently red, and that's fine

`Deploy backend` fails on master right now, on purpose, because
`ANTHROPIC_API_KEY` isn't set. That does **not** block merging. It is not a
required check, and this was tested explicitly rather than assumed. Do not "fix"
this by adding the key without deciding to.

---

## Emergencies: who can override

**Nobody can bypass the rules, deliberately — including admins.** That is
unusual, so here is why. When repository admins were given bypass rights, a
routine tool call using GitHub's merge API merged a knowingly-broken change
straight into master without warning. Bypass rights don't just protect a human
in an emergency; they silently exempt every script running as that human, and
we have many. So the bypass list is empty and the rules apply to everyone.

**The emergency override is to switch the ruleset off**, which only
**Taylor (`taylorhorizon`)** and **Ammon (`isaacammonbarlow-max`)** can do — they
are the two repository admins. Either:

- GitHub → repo **Settings → Rules → Rulesets** → open *"master: audit every
  change against live"* → set **Enforcement** to **Disabled** → Save. Set it back
  to **Active** afterwards.
- Or ask an agent to run:
  `gh api -X PUT repos/Infinity-Windows/infinity-windows/rulesets/19997293 -f enforcement=disabled`

This is a deliberate, logged, two-admin action rather than something a script can
do by accident. Use it for a genuine outage, then turn it back on.

---

## Two known consequences worth knowing

**The nightly vault sync will start failing.** `vault-sync.yml` pushes its
Obsidian vault update straight to master every night, and master no longer
accepts direct pushes — the push is refused with *"Changes must be made through a
pull request."* It cannot simply open a PR instead: pull requests opened by
GitHub's own automation don't trigger the tests, so the required checks would
never report and the PR would sit forever. Fixing it needs one decision — either
give that job a saved credential of its own so its pull requests behave like a
person's, or point the vault mirror at its own branch instead of master. Nothing
users see is affected either way; the vault just stops refreshing until it's
done.

**There are a few odd commits in master's history from testing this.** Proving
the rules actually work meant merging a deliberately broken change and reverting
it (`test: deliberately break the build...` immediately followed by `Revert the
throwaway build-break probe`), plus four small `behind-branch verification` /
`Remove throwaway verification file` commits. They are all reverted or cleaned
up, master's files are back to normal, and nothing is left behind. If you're
reading the history and they look alarming — they were the test, not a mistake.

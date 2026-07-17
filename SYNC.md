# SYNC.md — How We Stay In Sync

This is our team playbook for staying on the same page (and the same code). It's
written for humans, not git experts. If you follow the routine below, you will
almost never hit the "why does my screen look different than yours?" problem
again.

If anything here is confusing, **stop and ask** before running commands you don't
understand. It's always cheaper to ask than to untangle a mess later.

---

## The One Rule

**`master` is the single source of truth.**

- `master` is always the latest, correct version of the app.
- Everyone syncs *to* `master`. Nobody pushes *directly* to `master` — new work
  lands through a **Pull Request (PR)** that a human reviews and merges.
- What you see on your screen should match `master`. If it doesn't, you are
  behind — sync (see below).

That's the whole philosophy. Everything else is just how to keep your computer
lined up with `master`.

---

## Daily Start Routine (do this every time you sit down to work)

The easy way — from the repo root, just run:

```bash
npm run sync --prefix app
```

...or from inside the `app/` folder:

```bash
npm run sync
```

That runs our safe sync script for you. If you'd rather do it by hand, or want to
understand what the script does, here are the exact steps:

```bash
# 1. Get the latest info from GitHub (does not change your files yet)
git fetch origin

# 2. Move onto the master branch
git checkout master

# 3. Pull the latest master (ff-only = no surprise merge commits)
git pull --ff-only origin master

# 4. If dependencies changed, reinstall them (safe to run every time)
cd app && npm install && cd ..

# 5. Restart Vite (stop it with Ctrl+C in its terminal, then:)
cd app && npm run dev

# 6. Hard-refresh your browser (see "The PWA Cache Gotcha" below)
```

**After syncing, your app should look exactly like everyone else's.** If it
doesn't, jump to Troubleshooting.

---

## How to Confirm You Have the Latest

Check the commit you're currently on:

```bash
git log --oneline -1
```

Check what the latest commit on GitHub is:

```bash
git fetch origin
git log --oneline -1 origin/master
```

**These two should print the same commit.** If they match, you are fully synced.
If they don't match, you are behind — run the daily sync routine above.

You can also see both at once:

```bash
git fetch origin
echo "You are on:   $(git log --oneline -1)"
echo "Latest is:    $(git log --oneline -1 origin/master)"
```

---

## How Work Ships (the PR workflow)

We do **not** push straight to `master` anymore. Instead, every change ships
through a **Pull Request (PR)** — a proposed change that a human reviews and
clicks **Merge** on.

**The good news for Taylor & Ammon: you don't do any of this by hand.** Your
Cursor agent does all the git for you. You just describe the change you want in
plain English, and the agent will:

1. Start from the latest `master`.
2. Make a short-lived branch.
3. Make the change (and run a quick build/test check when it matters).
4. Commit, push the branch, and open a PR.
5. Hand you a **PR link** in chat.

Your only job is to **open that link, glance at it, and click the green Merge
button** (or ask a teammate to). Once it's merged, it becomes part of `master` —
then everyone just syncs (see the Daily Start Routine) to get it.

- **Never type git commands yourself.** If you catch yourself about to run
  `git push`, stop — that's the agent's job. Just tell the agent what you want.
- **One PR = one concern.** If two unrelated things changed, that's two PRs.
- **If the agent says a branch "collided" or "diverged,"** let the *agent* fix
  it (it will rebase). Humans never hand-edit git.

---

## Database Changes (Supabase) — the agent's job, never yours

Some changes need a matching change to the **shared database** (a "migration" —
e.g. adding a new column or table). The app's data lives in cloud Supabase, not
on your laptop, so a code change that expects a new column won't work until the
database is updated too.

**You never do this by hand.** If a Cursor agent ever tells you to "open
supabase.com, paste this SQL into the SQL Editor, and click Run" — **stop, that
is wrong.** Taylor and Ammon do not need Supabase dashboard access, and nobody
hand-runs SQL. Applying migrations to the shared database is the **agent's job.**

How it actually works:

1. When your change needs a database update, the agent writes a migration file
   into `supabase/migrations/` **as part of the same PR** (so the SQL is
   reviewed alongside the code).
2. The agent **applies that migration to the shared Supabase database for you**
   (it has database access via its tools) so the live app is ready.
3. You just review and **Merge the PR** like any other change.

So if you're blocked with a "you don't have Supabase access" or "run this
migration first" message: **you don't need access.** Paste that message to your
Cursor agent and say *"apply the migration for me and open the PR."* The agent
handles the database and the git; you only click Merge.

---

## Branches: Keep Them Short-Lived

Every change lives on its **own short-lived branch**, and that branch becomes a
PR. The agent handles creating and cleaning these up — you shouldn't need to
think about branches at all.

If a branch does stick around:

- Keep it alive for **hours, not days**.
- Merge or delete it as soon as its PR is merged.

Long-lived branches are exactly what caused our last sync mess. Avoid them.

---

## The Stale Cache Gotcha (read this!)

Your browser can quietly keep an *old* version of the app alive using a
"service worker" — a background script that intercepts page loads and can serve
a cached bundle. So even after you sync the latest code and restart Vite, your
browser might **still show the old design.** This is not a code bug — it's your
browser being "helpful."

> **Important:** this app itself does **not** use a service worker. The stale
> worker is almost always left over from a *different* project that once ran on
> the same address (e.g. `http://localhost:5173`). Service workers are tied to
> the address, not the project — so an old one can hijack a brand-new app.

### The durable fix (already built in)

As of this fix, the app **automatically unregisters any leftover service worker
and clears its cache on every load**, then reloads once so you see fresh code.
You should never have to do this by hand again. If you're on the latest commit
and still see something old, do a one-time manual clear (below) — after that the
auto-cleanup keeps it from coming back.

### Fix: Hard Refresh

- **Mac:** `Cmd + Shift + R`
- **Windows/Linux:** `Ctrl + Shift + R`

### Fix (stronger): Empty Cache and Hard Reload

If a plain hard refresh isn't enough:

1. Open **DevTools** (`Cmd/Ctrl + Option/Shift + I`, or right-click → Inspect).
2. **Click and hold** the browser's refresh button (with DevTools open).
3. Choose **"Empty Cache and Hard Reload."**

### Fix (nuclear, one time): Unregister the Service Worker + Clear Site Data

If it's *still* showing the old version:

1. Open **DevTools** → **Application** tab → **Service Workers**.
2. Click **Unregister** on every worker listed.
3. Under **Application → Storage**, click **Clear site data**.
4. Close the tab, reopen the app, and refresh.

After this one-time clear, the app's built-in auto-cleanup takes over and a stale
worker can't come back and mask new code again.

> Rule of thumb: if you synced the latest code but the screen looks old, it's
> almost always the cache. Hard refresh first.

---

## Safe Git Defaults (set once per computer)

Run this **once** inside the repo folder. It's repo-local (only affects this
project) and stops git from ever making surprise merge commits when you pull:

```bash
git config --local pull.ff only
```

With this set, `git pull` will only fast-forward. If a plain fast-forward isn't
possible, git will stop and tell you — which is exactly what we want, because it
means it's time to **stop and ask** instead of creating a tangled history.

> Note: this is *local* to this repo. It does not change your global git settings
> or any other project.

---

## Troubleshooting

### "My localhost shows the old design"

99% of the time this is the PWA cache, not the code. In order:

1. Confirm you're actually synced: `git log --oneline -1` should match
   `git log --oneline -1 origin/master` (see "How to Confirm" above). If not,
   run the daily sync.
2. Make sure Vite was restarted after syncing (`Ctrl+C`, then `npm run dev`).
3. **Hard refresh** (`Cmd/Ctrl + Shift + R`).
4. **Empty Cache and Hard Reload** via DevTools.
5. Unregister the service worker + Clear site data (see PWA section).

### "git says my branch has diverged"

This means your local history and `master` went down different paths. **Do not
force push.** Instead:

```bash
git fetch origin
git status          # read what it says
```

Then **stop and ask** in chat before doing anything else. Diverged history is the
exact situation that bit us last time — it's worth 5 minutes of asking.

### "I have uncommitted changes and need to switch/sync"

Git won't let you switch branches with unsaved work. Either commit it:

```bash
git add -A
git commit -m "wip: short note"
```

...or temporarily shelve it with **stash**:

```bash
git stash            # tucks your changes away safely
git checkout master
git pull --ff-only origin master
git stash pop        # brings your changes back on top
```

If `git stash pop` reports a conflict, see the next section.

### "Merge conflict — stop and ask"

If git ever says **CONFLICT** (during pull, rebase, merge, or stash pop):

- **Don't guess.** Don't delete files. Don't force push.
- Take a screenshot of what the terminal says.
- **Stop and ask** in chat so we can resolve it together.

A conflict just means two people changed the same lines. It's routine to fix —
but only if we do it carefully instead of panicking.

---

## TL;DR Cheat Sheet

```bash
# Start of every session:
npm run sync --prefix app      # (or: cd app && npm run sync)

# Am I on the latest?
git fetch origin
git log --oneline -1            # should match:
git log --oneline -1 origin/master

# Save + share my work:
# Just tell your Cursor agent what you changed — it opens a PR and hands you a
# link. Open the link and click Merge. (You don't type git commands.)

# Screen looks old?  ->  Hard refresh: Cmd/Ctrl + Shift + R

# Anything says "diverged" or "CONFLICT"  ->  let the agent fix it (don't force)
```

# Is any of Ammon's work missing? — audit, 29 July 2026

## The short answer

**No. Nothing of Ammon's has been lost.**

Every single piece of work Ammon has done on this app is on `master` today,
except two things he himself has deliberately marked **"work in progress, please
don't merge yet"** — and both of those are safely saved on GitHub, waiting for
him to finish them.

We checked this the hard way: not by reading commit messages, but by taking every
change he has ever made under every name he uses, and asking git, one change at a
time, "is this on master?" 245 of his changes were checked. Every one is either
on master already, or belongs to a piece of work he has intentionally left open.

Nobody has overwritten, reverted or clobbered his work. The design work that went
missing earlier this month is on master and is **byte-for-byte identical** to the
copy he exported from his design tool. Today's nine automated merges did not touch
his part of the app at all.

Nothing was changed, deleted or pushed in the course of this audit. This document
is the only thing produced, and it is on its own branch, unmerged.

---

## 1. The names Ammon works under

Ammon shows up in the history under four different names. Three are definitely
his; the fourth is a shared robot account.

| Name in git | Email | Commits | Confidence it's Ammon |
|---|---|---|---|
| `isaacammonbarlow-max` | `isaacammonbarlow@gmail.com` | 91 | **Certain.** His GitHub account. Named as the author on every pull request he has merged. |
| `ETimpson314` | `timpsonel@gmail.com` | 51 (+103 more inside pull requests) | **Certain.** This is the name his own computer/agent signs commits with. Every branch behind a pull request that `isaacammonbarlow-max` opened was written by this name, and GitHub records it as co-author on 56 of his merged changes. It has never once opened a pull request of its own — it only ever appears as the working name behind his. |
| `Isaac Ammon Barlow` | `isaacammonbarlow@gmail.com` | 2 | **Certain.** Same email address as his GitHub account. Used only on the two commits that imported his design-tool export. |
| `Cursor Agent` | `cursoragent@cursor.com` | 55 | **Shared robot.** Used by both Taylor's and Ammon's AI agents, so it cannot be attributed by name alone. We instead checked every commit it made that names Ammon as co-author — 8 of them — individually. Result below; none is missing in substance. |

**Anything ambiguous?** Only `Cursor Agent`. Because it is used by everyone's AI
agent, we could not tell whose work each commit was from the name. We resolved
this by ignoring the name and checking the content instead: all 8 commits that
credit Ammon as co-author are accounted for (5 are directly on master, 3 belong
to pull requests that were closed and replaced by ones that *were* merged — see
§4). So the ambiguity does not leave any gap.

Two commands establish the identity list, for anyone who wants to repeat it:

```bash
git log --all --format='%an <%ae>' | sort -u
git log --all --format='%H|%an|%s' --grep='Co-authored-by: ETimpson314'
```

---

## 2. His changes, and how many are on master

Checked against `master` at `63e79b1` ("Read all three Supabase databases and
find the duplicate job (#146)"), using every branch **and every pull request**
GitHub has ever stored, including ones whose branches have since been deleted.

| | Count |
|---|---|
| Ammon's changes found anywhere in the project's history | **245** |
| Directly on `master` | **135** |
| Not directly on `master` | **110** |
| …of those, belonging to a pull request that **was merged** (so the change is on master, just combined into one tidy commit) | **107** |
| …of those, belonging to a pull request that was **closed and immediately replaced** by one that was merged | **1** |
| …of those, belonging to **his own two open drafts** | **2** |
| **Genuinely missing from master** | **0** |

The reason 110 of his changes are not on `master` by name is simply how this
project merges: when a pull request is merged, GitHub squashes all the small
work-in-progress steps into one clean commit. The small steps stay behind in the
pull request record; the *work* goes onto master. Every one of the 107 was traced
to its merged pull request, so nothing is hiding in that number.

How to verify:

```bash
git clone https://github.com/Infinity-Windows/infinity-windows.git
cd infinity-windows
git fetch origin '+refs/pull/*/head:refs/remotes/pr/*'
for sha in $(git log --all \
      --author=isaacammonbarlow@gmail.com \
      --author=timpsonel@gmail.com --format='%H' | sort -u); do
  git merge-base --is-ancestor "$sha" origin/master \
    || git log -1 --format='OFF %h %ad %s' --date=short "$sha"
done
```

---

## 3. The only two things of his not on master — both on purpose

These are his own drafts. He opened them himself, marked them draft, and wrote in
each one that it should not be merged yet. **Both are safe on GitHub.** Nothing
needs recovering.

### PR #136 — "Show the 'where it sits on the building' picture white-on-black"

- Branch `feat/invert-elevation-reference`, commit `65d643c`, 29 July 2026
- Files touched: `app/src/lib/install/drawingCrops.ts`
- His own note: *"Not live yet — this is a draft while I check the pictures look right."*
- Status: **open draft, safe on GitHub. Do not delete this branch.**

### PR #135 — "Checking whether a slightly wider window picture is safe on both jobs"

- Branch `fix/spec-crop-pad`, commit `3c2d4ea`, 29 July 2026
- His own note: *"Work in progress — please don't merge yet… If widening it spoils even one Smith picture that is right today, I'll close this and we keep what we have."*
- Status: **open draft, safe on GitHub. Do not delete this branch.**

He is deliberately holding both back until he has measured the Smith Residence
job. That is him being careful, not work going missing.

---

## 4. Did anyone overwrite or clobber his work?

This was the specific fear, so it was checked several separate ways. **All clear.**

### 4a. The design work — identical, not lost

The design work that appeared lost earlier this month is on master and is
**bit-for-bit the same file** Ammon exported.

His complete design export lives in commit `c28485a` ("Replace truncated
Infinity.dc.html with complete project export"). Master's copy is at
`design/infinity/Infinity.dc.html`.

| | Fingerprint | Size |
|---|---|---|
| Ammon's export (`c28485a`) | `8f39c0b2…` | 324,496 bytes |
| On master today | `8f39c0b2…` | 324,496 bytes |

Same fingerprint means the same file, to the byte. Not "similar" — the same. The
Nocturne design-system stylesheet, its readme, and both app icons are also
byte-identical.

His 105-term window & door glossary from `learn-data.js` was rebuilt as real app
code at `app/src/lib/glossary.ts`, whose own opening line reads *"Ported in full
from the Infinity 'learn-data.js' content (105 terms, 18 steps)."* We checked all
105 of his terms individually: **all 105 are present**, none dropped.

The information-architecture rebuild (`taylor/infinity-ammon-ia`, the "fall into
Ammon's layout" work) is confirmed on master — commit `1113d10` is an ancestor of
master today.

### 4b. Were any of his files deleted?

Nineteen file deletions have ever happened on master. Eight of them removed a
file Ammon had created. **Seven of the eight were done by Ammon himself**, tidying
up his own earlier work as he replaced it.

The one exception is deliberate and documented:

- `app/src/lib/authBypass.ts`, removed by Taylor on 18 July in PR #45 ("Remove the
  unintended guest sign-in bypass"). This was a "skip the login screen" shortcut
  that had to come out for security. It is an intentional, explained removal, not
  a mistake.

### 4c. Was anything force-pushed over?

No. There is **no record of a forced update anywhere** in this repository's logs
(`grep -rl 'forced-update' .git/logs/refs/` finds nothing). Master has only ever
moved forwards — every entry in its log is a plain "fast-forward", never a reset
or a rewind. Master even moved forward once *during* this audit (from `8507968`
to `63e79b1`) and that too was a clean one-commit fast-forward, verified.

One branch of his was rewritten, by him, harmlessly: on 20 July he committed a
folder of reference material by accident, noticed within two minutes, and
re-pushed the branch without it (`0b72337` → `9bec1c66`, both authored by him,
two minutes apart). The reference folder held a second copy of the design export
and a snapshot of the separate Horizon project. We compared that copy against
master's: master's has the interactive logic (174 working buttons and inputs, and
the design runtime) and **his accidental copy has none of it** — it was a
flattened print-style export. Master holds the better file. Nothing of value is
in the discarded version.

### 4d. Do his most important files still exist?

The 40 files he changed most often were checked one by one. **All 40 are present
on master** — including `app/src/index.css` (his design work, 37 changes),
`ProjectMap.tsx`, `PlansetUpload.tsx`, `App.tsx`, `nav.ts`, `Layout.tsx`,
`OpeningSheet.tsx` and `MyWork.tsx`. None missing, none emptied out.

### 4e. Closed pull requests — nothing abandoned

Three pull requests involving him were closed without merging. All three were
replaced within minutes by ones that *were* merged:

| Closed | Replaced by | Verified on master |
|---|---|---|
| #112 "Tie mark drawings to their planset" | #113, merged 2 minutes later | Yes — git confirms the change is already in master |
| #5 "Building + specs planset slots" | #7 "Dual planset slots", merged | Yes — all files present; his migration landed renamed as `20260717140000_planset_kind.sql` |
| #11 "View uploaded plansets in-app" | landed via #18 / #37 | Yes — `PlansetViewer.tsx` is on master |

---

## 5. Today's nine automated merges did not touch his work

Pull requests #137, #138, #139, #140, #141, #142, #143, #144, #145 (and #146,
which merged while this audit was running) all landed today. Every one was
Taylor's database-and-deployment work.

Across all of them: **15,124 lines added, 13 lines removed.** Those 13 removed
lines are all in setup instructions and database scripts — a README line, some
example environment values, and a few lines of a Python helper. **Not one line of
Ammon's app code was removed.**

The only two of his files they came near were touched additively:
`app/src/index.css` gained 23 new lines for a warning banner (nothing removed),
and `app/src/main.tsx` gained 2 lines to switch that banner on. No conflict, no
revert, no overwrite.

---

## 6. Stale branches: keep or delete

**Nothing of Ammon's is on the delete list.** Per the instruction to protect his
work, every branch that carries his name is marked keep, even where its content
is already safely on master.

**Nothing was deleted. This is a recommendation only.**

| Branch | Whose | State | Verdict | Why |
|---|---|---|---|---|
| `feat/invert-elevation-reference` | **Ammon** | PR #136 **open draft** | **KEEP — protected** | Unmerged work he is still finishing |
| `fix/spec-crop-pad` | **Ammon** | PR #135 **open draft** | **KEEP — protected** | Unmerged work he is still finishing |
| `chore/migration-drift-audit` | **Ammon** | PR #121 merged | **KEEP — his** | Content on master; kept because it is his |
| `feat/ai-assigned-openings-order` | **Ammon** | PR #103 merged | **KEEP — his** | Fully contained in master |
| `feat/ai-claude-backend` | **Ammon** | PR #104 merged | **KEEP — his** | Fully contained in master |
| `feat/ai-full-context` | **Ammon** | PR #102 merged | **KEEP — his** | Fully contained in master |
| `feat/ask-live-grounding` | **Ammon** | PR #83 merged | **KEEP — his** | Content on master |
| `feat/mark-specs` | **Ammon** | PR #107 merged | **KEEP — his** | Fully contained in master |
| `feat/points-categories` | **Ammon** | PR #106 merged | **KEEP — his** | Fully contained in master |
| `fix/anthropic-temperature` | **Ammon** | PR #105 merged | **KEEP — his** | Fully contained in master |
| `fix/map-error-and-planset-coverage` | **Ammon** | PR #115 merged | **KEEP — his** | Content on master |
| `refactor/photo-capture-consolidation` | **Ammon** | PR #80 merged | **KEEP — his** | Content on master |
| `fix/production-schema-drift` | Taylor | PR #138 merged, but branch still has changes not on master | **KEEP** | Genuinely unmerged content; needs a decision, not deletion |
| `chore/ship-backend-on-merge` | Taylor | PR #139 merged | Safe to delete | Content on master |
| `docs/project-consolidation` | Taylor | PR #141 merged | Safe to delete | Content on master |
| `docs/supabase-inventory-2026-07-29` | Taylor | PR #146 merged | Safe to delete | Content on master |
| `feat/supabase-merge-tooling` | Taylor | PR #145 merged | Safe to delete | Content on master |
| `fix/backend-deploy-must-fail-loudly` | Taylor | PR #142 merged | Safe to delete | Content on master |
| `fix/configurable-project-guard` | Taylor | PR #140 merged | Safe to delete | Content on master |
| `fix/defuse-db-push` | Taylor | PR #143 merged | Safe to delete | Content on master |
| `fix/pin-production-project` | Taylor | PR #137 merged | Safe to delete | Content on master |
| `fix/verify-functions-indeterminate` | Taylor | PR #144 merged | Safe to delete | Content on master |

### About the "8 stale branches" flagged earlier

Six of them have already been deleted from GitHub, before this audit began:
`chore/trim-root-tooling`, `feat/brain-catalog-gate-seed`,
`feat/installer-active-install`, `feat/installer-first-shell`, `feat/role-guards`
and `feat/vault-brain-sync`.

Five were Taylor's, and their content is on master. The sixth,
`chore/trim-root-tooling`, was Ammon's — and its content is on master too, apart
from the reference folder he had already discarded himself (see §4c). **Their
deletion cost nothing.** GitHub still holds the commits, and this can be checked
at any time:

```bash
gh api repos/Infinity-Windows/infinity-windows/commits/0b72337272321a97b4ff19062abe0be8d1cb3a19 --jq .sha
```

---

## 7. If you ever do need to recover something

Nothing needs recovering today. Kept here so a human has the commands if a branch
is deleted in future. **These are read-only inspection commands — they change
nothing.**

Look at a commit whose branch is gone:

```bash
git fetch origin 0b72337272321a97b4ff19062abe0be8d1cb3a19
git show 0b72337272321a97b4ff19062abe0be8d1cb3a19
```

Bring back the design export exactly as Ammon made it:

```bash
git fetch origin c28485a428e8acc4ae96f140c025bb71fec82a6d
git show c28485a428e8acc4ae96f140c025bb71fec82a6d:Infinity.dc.html > /tmp/Infinity.dc.html
```

Recover the two pieces of the design export that were never copied to master
(`learn-data.js`, the raw source behind the app's glossary, and `ios-frame.jsx`,
a phone-frame mockup). Neither is used by the app; the glossary content is
already on master in full:

```bash
git show c28485a428e8acc4ae96f140c025bb71fec82a6d:learn-data.js > /tmp/learn-data.js
git show c28485a428e8acc4ae96f140c025bb71fec82a6d:ios-frame.jsx  > /tmp/ios-frame.jsx
```

Retrieve any pull request's original commits, even if its branch was deleted:

```bash
git fetch origin '+refs/pull/*/head:refs/remotes/pr/*'
git log --oneline pr/136
```

---

## 8. What this audit changed

**Nothing.** No file was edited in the working copy. No branch was created,
switched, deleted or reset there. Nothing was pushed, nothing was force-pushed,
nothing was deleted, and no code pull request was opened.

Every check used read-only git commands (`git log`, `git show`, `git cherry`,
`git merge-base --is-ancestor`, `git ls-remote`, `git fsck`) plus read-only
GitHub API queries. Where a writable copy was needed, a **fresh separate clone**
was made in a temporary folder and used there.

This document is the sole output. It sits on its own branch as an unmerged pull
request, for a human to read and decide on.

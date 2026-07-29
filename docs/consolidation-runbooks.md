# Consolidation runbooks — how the database clean-up actually gets done

**Written:** 2026-07-29, against `master` at commit `63e79b1`.
**Governed by:** [`database-consolidation-decision.md`](./database-consolidation-decision.md).
**Measured facts from:** [`supabase-inventory-2026-07-29.md`](./supabase-inventory-2026-07-29.md).
**Row-level merge mechanics from:** [`supabase-merge-plan.md`](./supabase-merge-plan.md).

Nothing in this document has been executed. No database was written to, no
setting was changed, no transfer was performed. Every fact about the current
state came from a read-only query.

## Contents

1. [Which path is running, and why](#1-which-path-is-running-and-why)
2. [Path B — the one that is happening](#2-path-b--the-one-that-is-happening)
3. [The ordering constraint the owner needs to decide](#3-the-ordering-constraint-the-owner-needs-to-decide)
4. [Path B — verification](#4-path-b--verification)
5. [Path B — rollback](#5-path-b--rollback)
6. [The third project](#6-the-third-project)
7. [Loose ends that must not be forgotten](#7-loose-ends-that-must-not-be-forgotten)
8. [Path A — contingency only](#8-path-a--contingency-only)

---

## 1. Which path is running, and why

**Path B is running.** Production (`czprjcskmzzagdztqonm`) stays production. The
one genuinely new job in Ammon's database — "Black Desert" — comes across. Both
of Ammon's projects are then retired deliberately.

**Path A is not running.** Path A was the plan for "Ammon's database turns out to
hold the real field work, so he transfers it into the company organization and it
becomes production." The inventory answered that question: **neither database
holds any field work at all.** Zero install events, issues, quality checks, job
costs, job notes or attachments, in either. Not one of the 256 openings across
both has been measured or moved past "planned". There is nothing in Ammon's
database that would justify making it production, and production has all six crew
logins, the warehouse, and every reference in the app and the deployment
pipeline.

Path A is kept, compressed, in [section 8](#8-path-a--contingency-only), because
the research behind it is durable and the situation could change.

---

## 2. Path B — the one that is happening

### What actually moves

Exactly one job. From
[`supabase-inventory-2026-07-29.md` §7](./supabase-inventory-2026-07-29.md#7-merge-recommendation):

| | Rows |
| --- | ---: |
| `projects` — Black Desert, job code `BLACK22` | 1 |
| `project_plansets` | 3 — but two are the same PDF uploaded twice |
| `project_openings` | 42 |
| `project_mark_specs` | 37 |
| `project_mark_elevation_views` | 54 |
| `project_planset_pages` | 14 |
| `window_types` not already in production | 19 |
| `locations` — the two `J\|BLACK22\|` staging slots | 2 |
| **Total** | **172** |

Optionally 12 `schedule_events`, 1 `trip`, 1 `trip_crew`, 1 `procedures` and 1
`vault_config` row. All trivial, none load-bearing.

### What must NOT move, and why each one would hurt

This list matters more than the one above, because every item on it is a way the
merge goes wrong quietly.

**"Smith Residence" (`SMITH`) must not be merged as a new job.** It is not a
different customer. It is **Pecan Valley Town Homes Building 14 entered a second
time** under a different customer name and job code. Same two source PDFs, same
page counts, and **105 of its 105 opening codes are already in production.**
Merging it would create a second Building 14 with 105 duplicate windows filed
under a job code nobody recognises, and nothing in the app would flag it.

Searching for the job by name does not reveal this — that check returns "no
duplicate found", which is wrong. Job identity has to be checked on **source
planset filename plus opening-code overlap**, never on customer name or job code.

**"Oakridge" (`OAKRIDGE`) must not be merged.** It is an empty shell — no
plansets, no openings, no specs — and it collides with production's real Oakridge
row on `projects.job_code`, which carries a UNIQUE index. The merge would either
fail outright on this row or, worse, be "fixed" by someone renaming it. Drop it.

**The seeded reference data must not move.** `cost_codes` (6 rows), `tools` (8),
`supplies` (6) and `safety_talks` (7) are identical in both databases because the
same migration created them in both. `cost_codes.code` has **no unique
constraint**, so a naive copy silently produces twelve cost codes and a doubled
dropdown on every job-costing screen.

**The warehouse must not be re-serialised.** 40 of Ammon's 44 warehouse locations
are the *same physical shelf* as production's, seeded by the same migration.
Deduplicate on `(zone, rack, slot)` and discard Ammon's serial numbers. Do not
issue fresh serials for all 44 — that invents 40 shelves that do not exist and
would send someone to the warehouse to print labels for them.

**The six conflicting window types must be resolved by hand, keeping
production's.** `window_types.type_code` is UNIQUE, and six codes name different
windows in each database:

| Code | Production says | Ammon's says |
| --- | --- | --- |
| `4A` | 6080 XO (#4A) | Mark #4A |
| `4B` | 3060 (#4B) | Mark #4B |
| `13A` | 8080 XO (#13A) | Mark #13A |
| `13B` | 3060 FIXED (#13B) | Mark #13B |
| `18A` | 8080 XO (#18A) | Mark #18A |
| `18B` | 3060 FIXED (#18B) | Mark #18B |

These are Building 14 mark codes that were resolved to real window descriptions
in production and left generic in Ammon's. **Production's names are the specific
ones and are almost certainly right.** Keep them. The other 19 codes in Ammon's
database are genuinely new and safe to bring across.

### Who does what, in order

**Step 0 — before anything (Taylor, 5 minutes).** Take a fresh row-level backup
of production and commit it under `docs/backups/`. The existing
`docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json` was taken at 12:00
UTC, *before* the 2026-07-29 schema repair wrote 26 migration rows and four small
backfills. It is still the safety net for the data, but it is no longer a
snapshot of the current state. Take a new one.

**Step 1 — decide the extraction question (Taylor).** See
[section 3](#3-the-ordering-constraint-the-owner-needs-to-decide). This decision
gates everything after it, so make it first. It comes down to: does Taylor supply
an Anthropic API key now, or does the job get copied across row by row instead?

**Step 2 — get the PDFs out of Ammon's database (Taylor, or Ammon).** Both routes
need this, so do it either way. Three objects sit in Ammon's `plansets` bucket for
Black Desert, totalling 10,335,244 bytes:

- `Black_Desert_Windows_Pictures.pdf`
- `Black_Desert_Windows_Plans.pdf` — uploaded **twice**, 52 minutes apart on
  2026-07-28, both 3,249,106 bytes. Confirm they are the same file, then copy
  only one.

Taylor can do this himself. He holds the **Developer** role in Ammon's
organization, which grants read access to project content. He does not need to
wait for Ammon for this step.

Do not copy the other two objects in that bucket — they are the Building 14
planset and CAD set, which production already has. Copying them duplicates
5.9 MB of PDFs the company already stores.

**Step 3 — decide Ammon's login (Taylor).** Everything in Ammon's database was
created by one account, `isaacammonbarlow@gmail.com`. Production has no such
account — it has `ammon@horizonsolarusa.com`. **These are the same human under two
email addresses,** and matching accounts by email address (which
[`supabase-merge-plan.md` §8](./supabase-merge-plan.md) proposes) would wrongly
conclude they are two different people. Two acceptable answers:

- Attribute everything that comes across to the existing
  `ammon@horizonsolarusa.com` account. **Recommended** — it is his company
  address, and it keeps the crew list to six.
- Or invite `isaacammonbarlow@gmail.com` into production as a seventh account.
  Only do this if he actually wants to sign in with his personal address.

**Step 4 — bring Black Desert across.** Either the re-extract route or the
row-copy route, per Step 1. Full mechanics for the row-copy route are in
[`supabase-merge-plan.md`](./supabase-merge-plan.md), with the amendments listed
in [`supabase-inventory-2026-07-29.md` §7](./supabase-inventory-2026-07-29.md#7-merge-recommendation).

**Step 5 — verify.** [Section 4](#4-path-b--verification). Do not skip this and
do not let anyone declare the job done without it.

**Step 6 — retire Ammon's projects, deliberately.** Export both first, commit the
exports, *then* pause `jvsyhtarnvmdilsgksdi` — **pause, not delete** — and leave
it paused until production has been used for a full working week. Handle
`nbjmylctlklvazzlybts` per [section 6](#6-the-third-project). Once both are
retired, Ammon should downgrade his personal organization off the Pro plan so he
stops paying for databases nobody uses.

### What does NOT change in Path B, and this is the point

- **Nobody gets signed out.** Production is not moving. All six accounts, their
  passwords and their active sessions are untouched.
- **No configuration changes anywhere.** The project reference stays
  `czprjcskmzzagdztqonm`, so `app/src/lib/supabaseProject.ts`, `app/.env.example`,
  `.github/workflows/deploy-backend.yml`, `.github/workflows/vault-sync.yml`,
  `scripts/verify-functions.sh`, `scripts/pgq.sh`, `scripts/audit-migrations.sh`
  and `README.md` all stay exactly as they are.
- **No GitHub secrets change.** `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` still point at the right place.
- **No rebuild and no hard refresh needed** for the merge itself. The new job
  simply appears in the app.
- **No migrations to run and no edge functions to deploy.** All 70 repository
  migrations are already applied to production, and all ten edge functions are
  deployed and active there as of 2026-07-29 19:03 UTC.

That short list is the whole argument for Path B. It is a data task, not a
migration.

---

## 3. The ordering constraint the owner needs to decide

**This is a real dependency and it changes which route is cheaper. It should not
be decided silently by whoever runs the merge.**

Every Black Desert row is **derived output**. The 42 openings, 37 mark specs, 54
elevation views and 14 planset pages were all produced by the `extract-specs`
edge function reading three PDFs. Nothing in there was typed by a person, and all
42 openings are still unconfirmed extraction drafts — in Ammon's database
`confirmed` is false on every one of them.

That makes re-extraction the obvious route: upload the PDFs to production, run
extraction, let it produce the rows against production's own catalog. It sidesteps
the entire hazard list — no record-ID remapping, no serial re-issue, none of the
six window-type conflicts, no account remapping, no dependency ordering.

**But `extract-specs` cannot run on production right now.**

Verified read-only on 2026-07-29: the function is deployed and active (version 2)
on `czprjcskmzzagdztqonm`, but the secret `ANTHROPIC_API_KEY` **is not set on that
project.** The function's shared code calls `requireAnthropic()`, which throws
`"ANTHROPIC_API_KEY secret is not set"` the moment it is invoked. So the function
is deployed-and-broken, not missing — which is worse, because it looks fine until
someone uses it. Production currently holds `OPENAI_API_KEY` and the three VAPID
push keys, and no Anthropic key.

**Only Taylor can supply that key.** It is an Anthropic account credential; no
agent can create it.

### The two routes, honestly

| | **Re-extract** | **Copy the rows** |
| --- | --- | --- |
| Blocked on the Anthropic key? | **Yes** | No |
| Record-ID remapping | None | Required across 6 tables |
| The six window-type conflicts | Cannot occur — extraction works against production's existing catalog | Must be resolved by hand, one at a time |
| Warehouse serial handling | Not involved | Dedup on `(zone, rack, slot)`, discard source serials, issue 2 fresh ones above `SLOT-000042` |
| Dependency ordering | Not involved | Must be followed exactly — [`supabase-merge-plan.md` §4](./supabase-merge-plan.md) |
| Account attribution | Handled naturally by whoever runs it | Must be set by hand on every moved row |
| Risk | Extraction is not perfectly deterministic; may produce a different number than 42 openings | Every hazard above is a chance to corrupt production quietly |
| Effort once unblocked | Upload 2 PDFs, click extract, check the count | Half a day of careful SQL plus verification |

### Recommendation: re-extract, and get the key first

**Recommended route: re-extract. Recommended first action: Taylor sets
`ANTHROPIC_API_KEY` on `czprjcskmzzagdztqonm`.**

The reasoning is not really about Black Desert. It is this: **that key is needed
regardless.** `extract-specs` is the function that reads plansets, and it is
broken on production for *every* job, not just this one. The next time anyone
uploads a set of plans, it fails. So supplying the key is not extra work borrowed
to make the merge easier — it is work that has to happen anyway, and it happens to
unblock the safer route as a side effect. Doing the row copy to avoid the key
leaves the key unset, the function still broken, and production carrying 172
hand-merged rows it did not need to.

The one real cost of re-extracting is that extraction may not reproduce exactly
42 openings. That is acceptable here specifically because all 42 are unreviewed
drafts and no field work references any of them — there is no human judgement to
lose. Record the number extraction actually produces and compare it against 42;
if it is wildly different, stop and look at why before going further.

**Fall back to the row copy only if** the key genuinely cannot be obtained and
Black Desert is needed on site before it can be. In that case follow
[`supabase-merge-plan.md`](./supabase-merge-plan.md) with the amendments in
[`supabase-inventory-2026-07-29.md` §7](./supabase-inventory-2026-07-29.md#7-merge-recommendation),
filtering every table to the Black Desert project only. And set the key anyway
afterwards, because the function is still broken until someone does.

---

## 4. Path B — verification

Do not declare Path B done on "the merge script finished." Check these. Every one
is a `SELECT` and can be run with `scripts/pgq.sh`.

**The new job arrived, once.**

- `projects` holds exactly **3** rows: Pecan Valley Building 14, Oakridge, and
  Black Desert. Not 4.
- Exactly one row has `job_code = 'BLACK22'`.
- `project_openings` for Black Desert is a plausible count — 42 if rows were
  copied, close to 42 if extraction was re-run. **Write down the actual number**
  in the completion note, whatever it is.
- Its three (or two) plansets are present and each one opens in the app. A
  planset row that exists but whose file does not is worse than no row, because
  the app lists it and then fails.

**Nothing was duplicated.**

- Still exactly **one** Pecan Valley Building 14. No job whose opening codes
  overlap Building 14's. This is the check that catches an accidental `SMITH`
  merge.
- `cost_codes` still **6** rows, `tools` **8**, `supplies` **6**,
  `safety_talks` **7**. If any of these grew, the seed data was copied and the
  dropdowns are now doubled.
- `locations` at most **44** (the original 42 plus the two Black Desert staging
  slots), with `(zone, rack, slot)` unique and no duplicate serials.
- `window_types.type_code` has no duplicates, and `4A`, `4B`, `13A`, `13B`, `18A`
  and `18B` still carry production's specific descriptions — not "Mark #4A" and
  friends.

**Nothing was lost.**

- `auth.users` still **6** (or 7 if Ammon's personal address was deliberately
  invited). Never fewer.
- The warehouse is intact: 11 serialised windows, 6 movements, 5 window-ID
  counters.
- The signed toolbox record and its PDF are still there.
- All six accounts can still sign in. Nobody was signed out — production never
  moved.

**Nothing points at nobody.** Every row that records a person's ID resolves to a
real account. There is **no database constraint enforcing this** — nothing
pointing into the account system is policed — so a botched merge produces rows
that silently belong to no one. Check `profiles`, `project_openings.assigned_to`,
`toolbox_completions.profile_id`, `time_shifts.profile_id` and
`installer_clearance` by hand.

**The app is unaffected.** No "wrong database" banner. No rebuild was needed. No
GitHub secret changed. If any of those turned out to be necessary, something went
wrong — Path B does not touch configuration.

---

## 5. Path B — rollback

**Before starting.** Take a fresh row-level export of production and commit it
under `docs/backups/` (Step 0 above). Then write down, somewhere outside the
database, the record ID of the Black Desert job before you create it, and the
highest existing `locations.serial` (`SLOT-000042` today). Both are needed to
undo cleanly.

**If it goes wrong mid-way.** Path B is purely additive — it creates a new job and
adds rows that hang off it. Nothing existing is edited or deleted. So the rollback
is to delete the Black Desert job row and the rows that depend on it, then confirm
the counts in [section 4](#4-path-b--verification) are back to their starting
values (2 projects, 109 openings, 130 window types, 42 locations, 374 rows).

**Two things that are not covered by that.** If the seed tables were touched,
deleting Black Desert does not undo it — check `cost_codes`, `tools`, `supplies`
and `safety_talks` against 6/8/6/7 explicitly. And if the six conflicting window
types were overwritten with Ammon's generic "Mark #" names, restore them from the
backup taken in Step 0, because that is an edit to existing data and it is the one
way Path B can lose something.

**The source is its own safety net, so do not remove it.** Path B never writes to
`jvsyhtarnvmdilsgksdi`, which means the original Black Desert data stays intact
and correct for as long as that project exists. That is the real rollback:
if the merge is wrong, the source is still there to redo it from. **Which is
exactly why `jvsyhtarnvmdilsgksdi` must be paused rather than deleted, and left
paused until production has been used for a full working week.**

**A gap worth naming.** The committed artifacts for Ammon's projects —
`docs/inventory/jvsyhtarnvmdilsgksdi.json` and
`docs/inventory/nbjmylctlklvazzlybts.json` — are **inventories, not backups.**
They record table names, row counts and column names, not the row values, and
they contain none of the PDFs. Production has a real row-level backup
(`docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json`); Ammon's projects
do not. So a real export of `jvsyhtarnvmdilsgksdi` — rows and files — must be
taken and committed **before** it is paused, and certainly before anyone ever
deletes it.

---

## 6. The third project

`nbjmylctlklvazzlybts` sits in Ammon's personal organization, in `ca-central-1`
rather than `us-east-1`, created 2026-07-18 at 20:24 UTC — 86 minutes after its
sibling. Measured read-only, it contains **nothing**: no tables in `public` at
all (not empty tables — no tables), no migration history, no accounts, no storage
buckets, no files, no edge functions. Only Supabase's own stock schemas and five
stock extensions.

The likely story is a mis-selected region on the first attempt, abandoned
immediately and re-created in `us-east-1` — which fits the sibling being named
"Project 2".

**It must be resolved, not forgotten.** Being empty is a reason it is easy to
resolve, not a reason to ignore it. An unattended database in a personal account
is exactly the shape of the problem this whole exercise exists to fix, and a blank
one is a standing invitation for someone to start putting real work in it by
mistake.

**Recommended: delete it.** There is nothing to lose.

**But Taylor cannot delete it and should not try.** It belongs to Ammon's
organization, where Taylor holds only the Developer role. Deleting a project
requires Owner or Administrator. **This is Ammon's action, on Ammon's say-so.**

Whichever way it goes, the three acceptable outcomes are:

1. **Deleted** by Ammon, with `docs/inventory/nbjmylctlklvazzlybts.json` retained
   in the repository as the record that it was examined and found empty.
2. **Transferred** into the Infinity Windows organization if anyone wants it as a
   test database — but note it would stay in `ca-central-1` (a transfer cannot
   change region), and it would consume one of the two free-project slots.
   Not recommended.
3. **Deliberately abandoned**, meaning paused, with a written note here of who
   decided and when.

What is *not* acceptable is leaving it running and unmentioned. Free databases
pause themselves after a week of inactivity, so it will go quiet on its own — and
that is precisely how it gets forgotten. Record the outcome in this section when
it happens.

---

## 7. Loose ends that must not be forgotten

These are not part of the merge, but they were found while preparing it and they
should not be lost.

**`ANTHROPIC_API_KEY` is not set on production.** `extract-specs` and `ask` are
deployed and will fail when used. Only Taylor can fix this. See
[section 3](#3-the-ordering-constraint-the-owner-needs-to-decide).

**Two schema objects on production that no migration creates.** The table
`project_marks` and the column `project_plansets.story_label` exist in
`czprjcskmzzagdztqonm` and are created by nothing in `supabase/migrations/`.
`project_marks` is empty and nothing references it. **Migrations need to be
written for both** — or the objects dropped, if they were a mistake. Until then
the repository does not fully describe production, and anyone building a fresh
database from this repository gets something different from what the app runs
against. This is also why `supabase db push` must never be run against production
without a dry run first. (Not fixed here: another agent is working in
`supabase/migrations/`.)

**37 migration-history rows on production match no repository file.** Eleven were
applied out of band between 2026-07-15 and 2026-07-20; 26 were written by the
2026-07-29 schema repair. A cleanup script is waiting and deliberately not run at
`docs/migration-history-phantom-cleanup-2026-07-29.sql`. These rows hold no
application data, so nothing is at risk — but see the correction in
[`database-consolidation-decision.md`](./database-consolidation-decision.md):
production is the drifted database, not Ammon's.

**Ammon's personal organization is on the Pro plan.** Once both of his projects
are retired he should downgrade, or he keeps paying for databases nobody uses.

**The Infinity Windows organization is named "taylorhorizon's Org".** Not
"Infinity Windows". Renaming it is free, takes a minute, and only Taylor can do it
— and it is worth doing, because the whole point of
[`database-consolidation-decision.md`](./database-consolidation-decision.md) is
that anyone looking at the account can tell at a glance which organization is the
company's.

---

## 8. Path A — contingency only

**Not running.** Ammon's database holds no field work, so there is nothing in it
that would justify making it production. This section exists because the research
is durable and the situation could change — if a future database in someone's
personal account *does* accumulate real work, this is the path, and Rule 2 of
[`database-consolidation-decision.md`](./database-consolidation-decision.md)
requires it.

### The headline finding: a transfer preserves everything

**A Supabase project transfer between organizations moves only the billing and
ownership relationship. The database itself does not move. The project reference,
the web address, the API keys, the accounts and their hidden ID numbers, the
uploaded files, the edge functions and their secrets all stay exactly as they
were. Nobody gets signed out and the app's configuration barely changes.**

That is worth recording precisely, because it makes a transfer dramatically
cheaper than a data merge and it is the opposite of what
[`supabase-project-consolidation.md`](./supabase-project-consolidation.md)
assumes throughout — that document is entirely about *copying* between projects,
where accounts genuinely cannot be moved and everyone genuinely does get signed
out. Both statements are true; they are about different operations. **Copying
loses accounts. Transferring does not.**

**How this was established, and how confident to be.** Supabase's documentation
does not state "the project reference is preserved" in a single sentence, so this
is an inference — but a well-supported one, from four independent directions:

1. [Migrating within Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase)
   draws the distinction explicitly: *"If you need to move your project to a
   different organization **without touching the infrastructure**, see project
   transfers."* Project *migration* — the separate operation, which does create a
   new project and therefore a new reference — is described there as being "for
   changing regions or upgrading to new major versions." Transfer is the one that
   leaves the infrastructure alone.
2. [Project transfers](https://supabase.com/docs/guides/platform/project-transfer)
   states that a transfer *"cannot be used to transfer between different
   regions"*. A project that cannot change region is a project whose database
   instance is not being rebuilt somewhere else.
3. That same page's complete list of prerequisites and caveats is **entirely**
   about billing, plan features and permissions. It warns about a 1–2 minute
   downtime, about losing paid features, about the free-project limit, and about
   having a lesser role in the target organization. It says nothing whatsoever
   about keys rotating, accounts being lost, files needing re-upload, or the
   address changing — which, if any of those happened, would be the most
   important warning on the page.
4. Supabase's own Management API returns a structured eligibility report for a
   proposed transfer, listing errors, warnings and informational notes. Run
   read-only against both of Ammon's projects on 2026-07-29 targeting the Infinity
   Windows organization, it returned exactly one error — a permissions error — and
   **zero warnings**. No warning about keys, accounts, files or downtime.

The corroborating detail is that a project's Reference ID is presented in the
dashboard as the project's immutable identifier, while Organization is the field a
transfer changes. Only the name and the organization are editable there.

**Practical consequence.** Because the reference survives, none of the nine
hardcoded references would need to change: `app/src/lib/supabaseProject.ts`,
`app/.env.example`, `.github/workflows/deploy-backend.yml`,
`.github/workflows/vault-sync.yml`, `scripts/verify-functions.sh`,
`scripts/pgq.sh`, `scripts/audit-migrations.sh` and `README.md` would all keep
working, and the GitHub secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
would stay valid. That is only true for a *transfer*. It is emphatically not true
for switching the app to point at a different project, which is what Path A would
additionally require — see [below](#if-path-a-ever-runs-the-work-that-remains).

### How a transfer works

From [Project transfers](https://supabase.com/docs/guides/platform/project-transfer)
and [Access control](https://supabase.com/docs/guides/platform/access-control):

- **The click path.** Open the project, go to Settings → General, and use the
  transfer control. Pick the target organization and confirm.
- **Who initiates.** The **owner of the source organization**, and nobody else.
  Administrators explicitly cannot — the access-control matrix grants "Project ▸
  Transfer" to Owner only.
- **There is no acceptance step.** The person initiating must already be *at
  least a member* of the target organization. So the destination owner's
  involvement is to issue an invitation *beforehand*, not to approve anything
  afterwards. It is a one-sided action by someone who is an owner on one side and
  a member on the other.
- **Prerequisites and blockers.** Owner of the source organization; at least a
  member of the target; **no active GitHub integration connection**; no
  project-scoped roles pointing at the project (Team/Enterprise only); **no log
  drains configured**.
- **The project does not need to be paused first.** Nothing in the documentation
  requires it.
- **Region is unchanged and cannot be changed by a transfer.** A project in
  `ca-central-1` stays in `ca-central-1`.
- **Downtime:** *"a short 1-2 minute downtime if you're moving a project from a
  paid to a Free Plan."* Free-to-free or free-to-paid is not called out as
  incurring any.
- **Reversibility.** The transfer itself is not one-way in principle — it can be
  transferred back — but only by someone who is an owner of the *new* source
  organization, which is now the destination. Practically: once a project is in
  Taylor's organization, moving it back out requires Taylor. Billing is the part
  that cannot be undone: the source organization is invoiced for usage up to the
  transfer, the target for usage after.

### Plans and cost

Transfers between free and paid organizations are supported in both directions —
[Billing on Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase)
describes transfers as the intended way to arrange projects across plans, since
plans cannot be mixed inside one organization. Two constraints bite:

- **The free-project limit is two active projects,** counted **across all
  organizations** where you are an Owner or Administrator. Paused projects do not
  count. Moving a project into a free organization triggers a check against that
  limit, and the documentation's advice is to upgrade the target to Pro first.
- **Moving from Pro to Free loses the paid features** — point-in-time recovery,
  daily backups, and the guarantee against pausing after a week of inactivity.

### What would block Path A today

Measured read-only against the Management API on 2026-07-29:

| | Infinity Windows org | Ammon's personal org |
| --- | --- | --- |
| ID | `ipomvmrbigxqbmsamvdv` | `gdkmcyypdsmxmsdtdcgh` |
| Name as it actually reads | "taylorhorizon's Org" | "isaacammonbarlow-max's Org" |
| Plan | **free** | **pro** |
| Taylor's role | **Owner** | **Developer** |
| Ammon's role | **not a member** | **Owner** |
| Projects | 1 (`czprjcskmzzagdztqonm`) | 2 (`jvsyhtarnvmdilsgksdi`, `nbjmylctlklvazzlybts`) |

Four blockers, in the order they would need clearing:

1. **Taylor cannot initiate the transfer.** He holds Developer in Ammon's
   organization, and transfer requires Owner of the source. Supabase's read-only
   eligibility check, run against both of Ammon's projects, returns exactly this:
   `ERR_MISSING_OWNER_PERMISSION_ON_SOURCE_PROJECT` — *"You must be an owner of
   the project to transfer a project."* **Only Ammon can do it.** Promoting Taylor
   to Owner of Ammon's personal organization would also work and is a worse idea.
2. **Ammon is not a member of the Infinity Windows organization,** and he must be
   before he can transfer anything into it. **Taylor can fix this himself** — he
   is Owner there. Invite Ammon; a plain Member-level role is enough.
3. **The free-project limit.** The Infinity Windows organization is on the free
   plan with one project. Bringing one of Ammon's in makes two, which is exactly
   at the limit. Bringing **both** in makes three, which exceeds it and would be
   refused. Options: upgrade the Infinity Windows organization to Pro, or pause
   one project first, or resolve `nbjmylctlklvazzlybts` by deleting it (see
   [section 6](#6-the-third-project)) so only one project needs to move.
4. **Pro-to-free consequences.** Ammon's projects are on a Pro organization and
   would land on a free one: 1–2 minutes of downtime, loss of point-in-time
   recovery and daily backups, and the project becomes eligible to pause itself
   after a week of no use.

One prerequisite could not be verified from here and would need checking on the
day: whether Ammon's project has an active GitHub integration or any log drain
configured. Either one blocks a transfer until disconnected. He can see both in
his project's settings.

**Summary of who must act.** Taylor can invite Ammon into the Infinity Windows
organization, upgrade that organization's plan, and rename it — all himself. Only
Ammon can initiate a transfer, disconnect a GitHub integration on his project, or
delete anything in his organization.

### If Path A ever runs, the work that remains

A transfer moves the database intact, but it does not make it production. Making
a transferred project production is a separate and much larger job, and it is
where the real cost of Path A sits:

- **Repoint everything at the new reference.** All nine hardcoded references
  listed above, plus the GitHub secrets `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY` (the anon key has the project encoded inside it, so
  those two must always be replaced together, never separately), plus the
  Supabase-side runtime secrets, plus `app/.env` on every laptop, plus a re-link
  for anyone who has run `supabase link`. Then a rebuild, then everyone hard
  refreshes.
- **Crew accounts.** This is where the sign-out question actually lands. The
  transfer preserves the accounts *in the project it transferred*. But if the app
  is then repointed from `czprjcskmzzagdztqonm` to a different project, sessions
  are per-project, so **everyone signed in against the old project is signed
  out**, and cannot sign back in until an account exists for them on the new one.
  Ammon's project has exactly one account; production has six. So Path A means
  re-inviting five or six people who would each set a new password. **The
  transfer costs nobody a sign-out; the repointing costs everybody one.** Keep
  those two facts apart — conflating them is what makes a transfer sound
  expensive when it is not.
- **Apply and verify all 70 repository migrations** on the transferred project.
  (Ammon's project already sits exactly at the repository's tip — 70 applied,
  nothing extra — so today this would be a confirmation, not a migration run.)
  Plus migrations for the two undeclared objects in
  [section 7](#7-loose-ends-that-must-not-be-forgotten) if production's schema is
  to be reproduced.
- **Deploy all ten edge functions and set their secrets by hand.** The three
  `SUPABASE_*` values are injected by the platform automatically, but
  `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VAPID_PUBLIC_KEY` and
  `VAPID_PRIVATE_KEY` are not, and only Taylor can supply them.
- **Merge production's 374 rows in the other direction** — the whole warehouse,
  the 130-type catalog, the six crew profiles, the four Pecan Valley plansets and
  the signed toolbox record, all of which are the *irreplaceable* side of this
  comparison. This is strictly harder than Path B's 172 rows, and it is the
  reason Path A is the expensive path even with a free transfer.
- **Confirm the four storage buckets exist** — `plansets`, `install-media`,
  `toolbox-records`, `trip-attachments`. Two are empty, which is exactly why they
  get forgotten; if `install-media` does not exist, the first install photo
  anyone takes fails to upload.
- **Set the sign-in Site URL and redirect allow-list** to include
  `https://infinity-windows.github.io/infinity-windows/`, or sign-in fails
  silently on the live site.

**Rollback for Path A** is to transfer the project back and repoint the app at
`czprjcskmzzagdztqonm`, which is untouched throughout and fully backed up at
`docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json`. The transfer-back
requires Taylor, since he would by then be the owner of the source. The part that
does not roll back is passwords: anyone re-invited during Path A set a new one,
and reverting does not restore the old.

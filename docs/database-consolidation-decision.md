# Where the company's data lives — a standing decision

**Decided:** 2026-07-29, by Taylor Horsley.
**Status:** standing policy. This supersedes the earlier back-and-forth about
which database is the real one.
**Written against:** `master` at commit `63e79b1`.

## The two rules

**Rule 1. Infinity Windows data lives in an Infinity Windows Supabase
organization. Never in anyone's personal account.**

Today that organization is `ipomvmrbigxqbmsamvdv`, which Taylor owns. Every
database that holds real company work — jobs, crew accounts, plansets, install
records, the warehouse — belongs there.

**Rule 2. If company work ever ends up in someone's personal account, the fix is
to move the whole database into the company organization, not to copy the rows
out of it.**

Moving the database keeps it intact: same web address, same passwords, same
files, nobody signed out. Copying rows out means rebuilding accounts, re-linking
records to the right people, and hoping nothing was missed. Moving is one
afternoon's care. Copying is a week of it. So: move first, copy only when moving
is genuinely impossible.

## Why this is a rule and not just a preference

Three reasons, and the third is the one that actually happened.

**Billing.** Whoever owns the organization pays for it and decides whether to
keep paying. If the company's database sits in someone's personal account, the
company's ability to keep operating depends on that person's credit card not
expiring.

**Access control.** The organization owner decides who can see the data and who
can change it. Customer addresses, crew wages, job costs and plansets are
company records. The company should be the one handing out access to them.

**Continuity if someone steps away.** This is the concrete one. Taylor had to
ask Ammon for an invitation before he could look at his own company's job data.
Nothing went wrong and nobody behaved badly — Ammon sent the invitation. But it
should never have been his to send. If a collaborator is on holiday, changes
email address, or stops working with the company, the company still needs its
data on Monday morning. A database in a personal account makes that a favour
rather than a fact.

None of this is about trust. It is about not needing to rely on it.

## What this means today

As of 2026-07-29 there are three databases:

| Database | Whose organization | What is in it |
| --- | --- | --- |
| `czprjcskmzzagdztqonm` | **Taylor's — Infinity Windows** (`ipomvmrbigxqbmsamvdv`) | The live one. All six crew logins, the whole warehouse, the window catalog, both plansets for Pecan Valley Building 14 |
| `jvsyhtarnvmdilsgksdi` | Ammon's personal (`gdkmcyypdsmxmsdtdcgh`) | One genuinely new job, "Black Desert", plus a second copy of Pecan Valley and an empty job shell |
| `nbjmylctlklvazzlybts` | Ammon's personal (`gdkmcyypdsmxmsdtdcgh`) | Nothing at all. No tables, no accounts, no files |

The full measurement is in
[`supabase-inventory-2026-07-29.md`](./supabase-inventory-2026-07-29.md).

**So the current consequence of the policy is simple: production stays exactly
where it is.** `czprjcskmzzagdztqonm` is already in the Infinity Windows
organization, so Rule 1 is already satisfied for the database that matters.
Nothing needs to move, nobody gets signed out, and nothing in the app changes.

**The open item is what to do with Ammon's two personal projects.** Neither can
stay as it is indefinitely, because as long as a company job sits in a personal
account, Rule 1 is only half-true. The runbooks in
[`consolidation-runbooks.md`](./consolidation-runbooks.md) cover the work: bring
the Black Desert job into production, then retire both of Ammon's projects
deliberately rather than leaving them to rot.

### Why the decision landed here, and not on moving Ammon's database in

Rule 2 says move the database rather than copy the rows. That rule did not fire
this time, and it is worth writing down why, so nobody later thinks the rule was
ignored.

Rule 2 exists to protect real work that would be expensive to recreate — crew
accounts, install history, signed records, photos. **Ammon's database has none
of that.** Not one install event, issue, quality check, job cost, job note or
photo, in either database. Not one of the 256 window openings across both has
been measured or marked as started. It is one login (his own), the same seeded
warehouse and catalog everyone starts with, and the output of reading three
plan-set PDFs.

Meanwhile production holds all six crew logins, the warehouse, the catalog, the
signed safety record, and is the address baked into the app, both automated
workflows and the deployment secrets. So the cheap direction and the correct
direction are the same one: keep production, bring the one new job across.

If Ammon's database *had* held six months of field work, Rule 2 would have
fired, and the answer would have been for him to transfer the whole project into
the Infinity Windows organization and for that to become production. That path
is written down in
[`consolidation-runbooks.md`](./consolidation-runbooks.md) — compressed, because
it is not what is happening, but kept, because next time it might be.

## How this rule behaves in future situations

Written as rules rather than as a description of today, so it still governs
correctly when the facts change.

**A new database gets created in a personal account and real work starts landing
in it.** Move it. The owner of the personal organization transfers the project
into the Infinity Windows organization. The database keeps its web address, its
keys, its files and its logins, so the app and the crew are unaffected. Do not
copy the rows out.

**Someone needs their own database to experiment in.** Fine, and it should be in
their own account, and it must never be the one the app points at. The app
already warns about this: `app/src/lib/supabaseProject.ts` pins the expected
project and shows a red "wrong database" banner when the app is talking to
anything else. That banner is the enforcement mechanism. Do not disable it.

**A collaborator leaves, or goes quiet.** Company data is already in the company
organization, so nothing is stuck. Remove their access from the Infinity Windows
organization and carry on. Any database still in their personal account is
theirs to keep or delete, which is exactly why nothing of ours may be in there.

**A database in a personal account is being retired.** Never just forget it.
Take a real export of its rows and its files first, commit the export under
`docs/backups/`, and then pause or delete it deliberately. "We stopped using it"
is not a decision; it is a database quietly holding company records in someone
else's account.

**The company outgrows the free plan.** The Infinity Windows organization is on
the free plan today, which allows two active databases and pauses one after a
week of no use. If the company needs a second live database, daily backups, or
guaranteed no pausing, upgrade the Infinity Windows organization rather than
borrowing capacity from a personal account that already has it.

## What this supersedes

- [`supabase-merge-plan.md`](./supabase-merge-plan.md) recommended the same
  direction — keep `czprjcskmzzagdztqonm` — but for one wrong reason and before
  anyone had read Ammon's database. See the corrections note below.
- [`supabase-project-consolidation.md`](./supabase-project-consolidation.md)
  deliberately did not decide. Its closing position was "hold, get read access,
  and decide with numbers on both sides." Read access arrived, the numbers were
  taken, and this document is the decision it was waiting for. Its section 7 —
  the list of things nobody could find out — is now answered in
  [`supabase-inventory-2026-07-29.md`](./supabase-inventory-2026-07-29.md).

Neither of those documents should be rewritten. They describe what was believed
on a date, which is worth keeping.

### One correction worth carrying forward

Both earlier documents leaned on the claim that production was **"already at
zero schema drift."** That is the wrong way round.

- `jvsyhtarnvmdilsgksdi` has applied exactly the 70 migration files in this
  repository and nothing else. It is the one sitting precisely at the
  repository's tip.
- `czprjcskmzzagdztqonm` — production — has **107** migration-history rows, 37
  of which match no file in the repository. It also contains a table
  (`project_marks`) and a column (`project_plansets.story_label`) that **no
  migration in the repository creates at all.**

The direction still holds, for the reasons above: production has the crew
accounts, the warehouse, the catalog and every reference in the app, the
repository and the deployment pipeline. Those reasons are stronger than the
migration argument ever was. But **do not repeat the zero-drift claim** — it is
backwards, and it matters, because it means the repository's migration files no
longer fully describe production. Anyone who builds a fresh database from this
repository will get something subtly different from what the app runs against.

Two follow-up items come out of that, tracked in the runbooks: migrations need
writing for `project_marks` and `project_plansets.story_label` (or the objects
need dropping), and nobody should run `supabase db push` against production
without a dry run.

# Which Supabase project should we keep? A switch-over assessment

**Date:** 2026-07-29. **Written against:** `master` at commit `505c049`.

## The short version

Infinity Windows has two Supabase projects. A "project" here means one complete,
separate database with its own user accounts, its own uploaded files, and its own
web address. Nothing is shared between them. Work done in one is invisible in the
other.

* **`czprjcskmzzagdztqonm`** is what the deployed app actually talks to today.
  Verified in `app/.env`, `app/.env.example` line 11, and the GitHub Pages build.
* **`jvsyhtarnvmdilsgksdi`** is Ammon's project, which Taylor now believes holds
  the real ongoing work.

**The headline finding: switching to Ammon's project is much cheaper than it
sounds, because there is very little in `czprjcskmzzagdztqonm` worth moving.**

The whole database holds **374 rows across 18 tables** — the other 49 tables are
completely empty — and **12.7 megabytes of uploaded files**, which is four PDFs
and two small toolbox-talk files. Most of those 374 rows are demo and reference
data that the repository can recreate from scratch by re-running its setup
scripts. The genuinely irreplaceable human work amounts to roughly **four
uploaded plansets, 109 openings traced on one building, 28 window types created
during extraction, 9 hand-written notes, one signed toolbox talk, and six crew
accounts.** There is no install history, there are no install photos, there are
no receipts, there is one time entry, and there are zero job costs, issues, and
traced plan outlines.

**The one genuinely hard part is the six crew accounts.** Login accounts cannot
be copied between Supabase projects — the hidden ID number behind each account
is created by the system and cannot be chosen. Every crew member would have to be
re-invited on the new project and would set a new password. That is a real cost,
but with six people it is an afternoon, not a project.

**Recommendation: do not finalise this yet, and do not spend another hour on
`czprjcskmzzagdztqonm` either.** The single highest-value next step is to get
read access to `jvsyhtarnvmdilsgksdi` so the same inventory below can be produced
for it. Right now we are comparing a database we have counted precisely against
one we have never seen. If Ammon's project genuinely holds more real work — more
projects, more openings, more plansets, real install history — then option (b)
below is correct and the migration is small. If it turns out to hold roughly the
same demo data, option (a) is correct and costs nothing. **Either answer is cheap;
guessing between them is what is expensive.** See section 7.

---

## 1. Everything that is in `czprjcskmzzagdztqonm` today

**Conclusion: 374 rows in 18 tables, and 49 tables with nothing in them at all.**

The database has **67 tables** and 2 calculated views in the main (`public`)
area, plus 90 security rules, 195 stored database functions, and 11 automatic
triggers. Row counts below are exact counts taken with `execute_sql` on
2026-07-29, not estimates.

### Tables that have rows

| Table | Rows | What it is | Is this irreplaceable? |
| --- | ---: | --- | --- |
| `window_types` | 130 | The window and door catalog | **Partly.** See note below |
| `project_openings` | 109 | Every window opening on the two projects | **Yes** — extracted and reviewed from a planset |
| `locations` | 42 | Warehouse rack slots | No — created by setup script |
| `project_windows` | 26 | Physical windows tracked in the warehouse | No — demo data |
| `windows` | 11 | Window inventory records | No — demo data |
| `tools` | 8 | Tool list | No — created by setup script |
| `safety_talks` | 7 | The week's safety talk rotation | No — created by setup script |
| `cost_codes` | 6 | Job costing codes | No — created by setup script |
| `movements` | 6 | Warehouse movement log | No — demo data |
| `profiles` | 6 | Crew members, names and roles | **Yes** — see section 2 |
| `supplies` | 6 | Consumables list | No — created by setup script |
| `window_id_counters` | 5 | Counters that hand out window ID numbers | No — regenerates |
| `project_plansets` | 4 | The uploaded planset records | **Yes** — real uploads |
| `access_requests` | 3 | People asking for app access | Minor |
| `projects` | 2 | Oakridge Apartments Bldg C; Pecan Valley Town Homes — Building 14 | **Yes** |
| `installer_clearance` | 1 | One installer cleared for a window category | Minor |
| `time_shifts` | 1 | One clocked shift | Minor |
| `toolbox_completions` | 1 | One signed toolbox talk | **Yes** — a signature |
| **Total** | **374** | | |

**About the 130 window types.** The repository already contains a 100-row window
catalog as a file (`docs/window-catalog-100.csv` and the matching `.sql`), so
most of the catalog can be re-loaded on any project in seconds. What is *not* in
a file: **28 types marked "provisional"**, meaning the app created them
automatically while reading a planset; **9 types with hand-written notes**; and
**3 types with an AI-generated how-to guide** (`howto_json`). Every one of the
130 has AI-synthesised tips (`tips_json`), which could be regenerated by
re-running the tip synthesis, at the cost of some OpenAI usage. Zero types have
any recorded install statistics (`n_installs` is 0 everywhere), which confirms
nobody has completed an install through the app on this project.

### Tables with zero rows (49 of them)

`attachments`, `change_orders`, `cycle_counts`, `flights`, `ground_transport`,
`incidents`, `install_events`, `issues`, `job_costs`, `job_notes`,
`knowledge_chunks`, `knowledge_docs`, `learn_priority_terms`, `learn_progress`,
`lodging`, `points_ledger`, `procedures`, `project_mark_elevation_views`,
`project_mark_specs`, `project_marks`, `project_message_reads`,
`project_messages`, `project_plan_outlines`, `project_planset_pages`,
`project_spec_discrepancies`, `push_subscriptions`, `qc_checks`, `safety_acks`,
`schedule_assignment_members`, `schedule_assignments`, `schedule_events`,
`service_cases`, `supply_orders`, `task_sessions`, `trip_attachments`,
`trip_contacts`, `trip_crew`, `trips`, `vault_config`, `vehicle_devices`,
`vehicle_drive_sessions`, `vehicle_drivers`, `vehicle_financials`,
`vehicle_locations_history`, `vehicle_locations_latest`,
`vehicle_project_assignments`, `vehicle_service_records`,
`vehicle_service_schedules`, `vehicles`.

### The specific things you asked about, one by one

| Human work | Status in `czprjcskmzzagdztqonm` |
| --- | --- |
| Uploaded plansets | **4 files, 12.66 MB.** Three copies of `PVTH_Bldg_14_Marked.pdf` and one `PV_Townhomes_Bldg_14_Cads_2024-12-22.pdf`, all on Pecan Valley Building 14 |
| Traced plan outlines | **None.** `project_plan_outlines` is empty — nobody has hand-traced a building outline |
| Install history | **None.** `install_events` is empty. No install has ever been recorded |
| Install photos | **None.** The `install-media` bucket holds 0 objects |
| Voice memos | **None.** No install events, so no memos |
| Time entries | **1 row** in `time_shifts` |
| Job costs | **None.** `job_costs` is empty |
| Issues / callbacks | **None.** `issues` and `qc_checks` are both empty |
| Window catalog changes | **28 provisional types, 9 notes, 3 how-to guides.** The 100-row base catalog exists as a file in the repo |
| Crew profiles and roles | **6 profiles:** 2 owners, 4 installers |
| Receipts | **None.** No `attachments`, no `trip_attachments` |
| Mark drawings | **None.** `project_marks`, `project_mark_specs` and `project_mark_elevation_views` are all empty |
| Openings progress | **109 openings, all still at status "planned."** Exactly 1 is assigned to an installer, and 0 have had their rough opening measured |

There is also a **complete JSON backup of every non-empty table** already
committed at `docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json`
(243,943 bytes). If this project is retired, that file is the safety net for
every row listed above except the uploaded files and the login accounts, neither
of which a JSON export can capture.

---

## 2. Login accounts — the genuinely hard part

**Conclusion: there are 6 login accounts, and they cannot be moved. On a new
project all six people must be re-invited and will set a new password. The
existing data that points at them can be repaired, but only by hand and only if
someone maps each old account to each new one.**

Counted directly:

| What | Count |
| --- | ---: |
| `auth.users` (login accounts) | **6** |
| `auth.identities` (sign-in methods) | 6 |
| `auth.sessions` (currently signed-in devices) | 8 |

All six were created on 2026-07-15, between 18:18 and 21:23 UTC.

### How `profiles` relates to those accounts

Every login account has exactly one matching profile row: 6 profiles, 6 login
accounts, all 6 profile IDs match a login account ID, and there are no orphans.
So in practice `profiles` is the "crew list" and each row is keyed to one login.

**But — and this matters for the migration — there is no enforced link.** We
checked every foreign key in the database and found **zero** pointing into the
login system. `profiles.id` happens to equal `auth.users.id`, and the app relies
on that, but the database does not police it. Two consequences:

1. **Good news for a migration.** Because nothing is enforced, you *can* insert
   profile rows and opening assignments on a new project without the matching
   login accounts existing yet. The database will not stop you. It also will not
   warn you.
2. **Bad news for correctness.** That means a botched migration produces rows
   that quietly point at nobody. "Assigned to" would show blank, a signed toolbox
   talk would belong to no one, and nothing in the app would flag it. The
   breakage would be silent, which is the same failure mode that created the
   two-database problem in the first place.

### Why login IDs cannot be recreated

When you create a user in Supabase, the system generates a random hidden ID and
there is no supported way to choose it. So on `jvsyhtarnvmdilsgksdi`, Taylor's
account will have a *different* hidden ID than it does on
`czprjcskmzzagdztqonm`, even with the same email address. Every piece of data
recorded against the old ID becomes meaningless unless it is rewritten.

Here is every place in the database that stores a person's ID, so you can see the
scope. Today most of these are empty, which is exactly why moving now is cheap:

| Table and column | Rows affected today |
| --- | ---: |
| `profiles.id` | **6** |
| `project_openings.assigned_to` | **1** |
| `toolbox_completions.profile_id` | **1** |
| `time_shifts.profile_id` (also `approved_by`, `edited_by`, `rejected_by`) | **1** |
| `installer_clearance.installer_id`, `cleared_by` | **1** |
| `access_requests.decided_by` | up to 3 |
| `projects.green_light_by` | 0 |
| `install_events.installer_id`, `voided_by` | 0 |
| `issues.assigned_to`, `created_by`, `fault_by`, `resolved_by` | 0 |
| `job_costs.created_by` | 0 |
| `job_notes.author_id` | 0 |
| `points_ledger.profile_id` | 0 |
| `learn_progress.profile_id` | 0 |
| `qc_checks.checked_by` | 0 |
| `safety_acks.profile_id` | 0 |
| `project_messages.author_id`, `project_message_reads.profile_id` | 0 |
| `push_subscriptions.profile_id` | 0 |
| `schedule_assignments.created_by`, `schedule_assignment_members.profile_id` | 0 |
| `service_cases.installer_id`, `reported_by`, `resolved_by` | 0 |
| `task_sessions.profile_id` | 0 |
| `trips.created_by`, `trip_crew.profile_id`, `trip_attachments.created_by` | 0 |
| `vehicles.created_by`, `vehicle_drivers.profile_id`, `vehicle_drive_sessions.driver_id` | 0 |
| `flights.profile_id`, `incidents.profile_id` | 0 |
| `knowledge_docs.created_by`, `vault_config.updated_by` | 0 |
| `project_spec_discrepancies.acknowledged_by` | 0 |

**The practical upshot:** moving crew today means re-inviting six people and
fixing about ten rows. Doing the same migration six months from now, after real
install history, photos, time entries and points have accumulated, means
rewriting thousands of rows with no room for error. **If we are ever going to
switch, now is by far the cheapest moment.**

Also worth naming: those 8 active sessions mean anyone currently signed in on a
phone gets signed out when the app is repointed, and will need to sign in again
with a new password.

---

## 3. Uploaded files

**Conclusion: 4 storage buckets, 6 files, 13,297,736 bytes (12.68 MB) in total.
Files live inside a single project and are not visible from the other one; they
must be downloaded and re-uploaded by hand or by script.**

| Bucket | Public? | Files | Size | What it holds |
| --- | --- | ---: | ---: | --- |
| `plansets` | No | **4** | 13,278,477 bytes (12.66 MB) | Planset PDFs |
| `toolbox-records` | No | **2** | 19,259 bytes (0.02 MB) | One signed toolbox-talk PDF plus its signature image |
| `install-media` | No | **0** | 0 | Install photos — nothing uploaded yet |
| `trip-attachments` | No | **0** | 0 | Travel receipts — nothing uploaded yet |
| **Total** | | **6** | **13,297,736 bytes** | |

The four planset files are all for Pecan Valley Building 14: three copies of
`PVTH_Bldg_14_Marked.pdf` (uploaded under two different project folders) and one
`PV_Townhomes_Bldg_14_Cads_2024-12-22.pdf` specs sheet.

### Which app features break if the files are not copied

Each bucket has a specific consumer in the app, so the failure is predictable:

| Bucket | Where the app uses it | What breaks if the files are missing |
| --- | --- | --- |
| `plansets` | `app/src/lib/install/api.ts` line 577 (upload), line 611 (download), line 911; queued for offline in `app/src/lib/install/queue.ts` line 9 and `installOutbox.ts` line 16 | The plan viewer and the project map go blank. `project_plansets` rows would still exist, so the app would list four plansets and fail to open any of them — worse than showing none |
| `install-media` | `app/src/lib/photos.ts` line 49, `app/src/lib/install/api.ts` line 2413, `app/src/lib/offline/outbox.ts` line 294, `outboxHandlers.ts` line 151, `OpeningSheet.tsx` lines 422–471, `PhotoCaptureSheet.tsx` line 144 | Nothing today — the bucket is empty. **But the bucket itself must exist on the new project**, or the very first install photo anyone takes fails to upload |
| `toolbox-records` | `app/src/lib/toolbox.ts` line 10 | The one completed toolbox talk loses its signed PDF, which is the record you would want if anyone ever asked to see proof of the talk |
| `trip-attachments` | `app/src/lib/travel/api.ts` line 29 | Nothing today — empty. Bucket must still exist |

**The important detail is that empty buckets still have to be created.** Two of
the four buckets hold nothing, so there is no data to copy, but if
`jvsyhtarnvmdilsgksdi` does not already have buckets by these exact names, photo
capture and receipt upload will fail the first time crew try to use them. That is
a five-minute setup step that is very easy to forget precisely because there is
no data to migrate.

---

## 4. Every place the project is named or configured

**Conclusion: 9 files in the repository, 2 GitHub secrets, 1 file on each
person's laptop, and several settings inside the Supabase dashboard. Line numbers
are against `master` at commit `505c049`.**

### In the repository — must change

| File and line | What is there now | Note |
| --- | --- | --- |
| `app/.env.example` line 11 | `VITE_SUPABASE_URL=https://czprjcskmzzagdztqonm.supabase.co` | The address the app connects to |
| `app/.env.example` line 12 | `VITE_SUPABASE_ANON_KEY=...` | The public key. **It is specific to the project** — the project name is encoded inside it, so it must be replaced together with the URL, never separately |
| `app/.env.example` line 3 | Comment naming the one shared project | Wording |
| `app/src/lib/supabaseProject.ts` line 13 | `export const EXPECTED_PROJECT_REF = "czprjcskmzzagdztqonm";` | **This is the switch.** This one line drives the red "Wrong database" banner. Flip it and the banner starts warning about `czprjcskmzzagdztqonm` instead |
| `app/src/lib/supabaseProject.test.ts` lines 10, 15, 50, 77 | Uses `jvsyhtarnvmdilsgksdi` as the example of the *wrong* project | The tests would need the two projects swapped, or they fail |
| `.github/workflows/deploy-backend.yml` line 35 | `SUPABASE_PROJECT_REF: czprjcskmzzagdztqonm` | Decides which project gets the edge functions and migrations on every merge |
| `.github/workflows/vault-sync.yml` line 49 | `SUPABASE_URL: https://czprjcskmzzagdztqonm.supabase.co` | The nightly Obsidian vault sync would keep reading the retired project |
| `scripts/verify-functions.sh` line 25 | `REF="${SUPABASE_PROJECT_REF:-czprjcskmzzagdztqonm}"` | Default when no project is named |
| `README.md` line 59 | "There is ONE shared Supabase project: `czprjcskmzzagdztqonm`" | The instruction everyone reads first |

### In the repository — comments and history, lower priority

| File and line | What is there |
| --- | --- |
| `scripts/pgq.sh` lines 18, 25 | Comment and usage example naming the production project. The script itself has **no default** any more, which is correct — it refuses to run until you name a project |
| `scripts/audit-migrations.sh` line 12 | Comment showing the production project as the example |
| `app/src/lib/supabaseProject.test.ts` line 35 | Uses the name in a parsing test |
| `docs/migration-audit-2026-07-28.md` lines 7, 12, 19, 24, 25, 338 | Historical record |
| `docs/migration-drift-2026-07-28.sql` line 5 | Historical record |
| `docs/migration-drift-2026-07-29-production.md` lines 1, 5, 13, 33, 202, 212, 216 | Historical record |
| `docs/migration-repair-2026-07-29-production.md` lines 1, 11, 34, 36, 42, 44, 48, 285, 300, 304 | Historical record |
| `docs/backups/2026-07-29T1200Z-czprjcskmzzagdztqonm-full.json` line 639, and the filename | The backup. **Leave this alone** — it is a record of a specific project at a specific moment |

These historical documents should **not** be rewritten. They describe what was
true on a date. If the decision changes, the right move is to add a short note at
the top of each pointing at the new decision, not to edit the history.

### GitHub repository secrets

Secret *names* are readable; their values are not, by anyone, including us. Only
someone with the new project's credentials can set them.

| Secret | Currently set? | Action needed if we switch |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Yes, 2026-07-19 | **Must be reset.** This is what the live site is built with |
| `VITE_SUPABASE_ANON_KEY` | Yes, 2026-07-19 | **Must be reset**, together with the URL |
| `SLACK_CHANGELOG_WEBHOOK` | Yes, 2026-07-18 | Unrelated, no change |
| `SUPABASE_ACCESS_TOKEN` | **No** | Needed by `deploy-backend.yml` to deploy edge functions |
| `SUPABASE_DB_PASSWORD` | **No** | Needed by `deploy-backend.yml` to push migrations |
| `SUPABASE_SERVICE_ROLE_KEY` | **No** | Required by `vault-sync.yml`, which fails without it |

**Three of the six secrets the repository expects do not exist.** This is why the
"Deploy backend" workflow reports success while deploying nothing: it is written
to skip with a warning rather than turn the build red. Whichever project wins,
these three secrets have to be created for that project before automatic backend
deployment does anything at all.

### Not in the repository, easy to forget

* **`app/.env` on every laptop.** This file is deliberately not in git
  (`.gitignore` line 3), so each person must copy the new `.env.example` over
  their own `.env`. Until they do, they keep working against the old project and
  will see the red "Wrong database" banner — which is exactly what that banner
  is for.
* **`supabase/config.toml` names no project.** It only sets `verify_jwt = true`
  for the ten functions, so nothing in it needs changing. But the Supabase
  command-line tool remembers which project it is linked to in local state, so
  anyone who has run `supabase link` needs to re-link.
* **Inside the Supabase dashboard of the winning project:** the sign-in Site URL
  and redirect allow-list must include
  `https://infinity-windows.github.io/infinity-windows/`, or sign-in silently
  fails on the live site. The four storage buckets must exist. The security rules
  and the ten edge function secrets must be in place.
* **A rebuild is required.** The live site has the project address baked into its
  JavaScript at build time, so changing the secrets does nothing until a build
  runs. Merging to `master` triggers it, and everyone must hard-refresh.

---

## 5. Edge functions and the secrets they need

> **Superseded later the same day. Do not act on the "Not deployed" column
> below.** The table was measured earlier on 2026-07-29, before `Deploy backend`
> ran. As of the 20:02 UTC run against `czprjcskmzzagdztqonm`, **all ten
> functions are deployed** — probed 401 each, 0 missing, 0 undetermined — and the
> only secret still missing on that project is `ANTHROPIC_API_KEY`.
> `OPENAI_API_KEY`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are all set, so
> `send-push` in particular is deployed **and** has its keys. The section is kept
> as written because it is the record of what was true at the time; the live
> state is in [`always-live.md`](./always-live.md), and the current answer always
> comes from `scripts/verify-functions.sh` and
> `scripts/verify-function-secrets.sh` rather than from this table.

**Conclusion (as measured earlier on 2026-07-29): only 4 of the 10 functions are
running on `czprjcskmzzagdztqonm`. Whichever project wins needs all ten deployed
and needs four secrets set by hand: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.**

Verified by probing production on 2026-07-29. A response of 401 means the
function exists and is asking for a login; 404 means it was never deployed.

| Function | Live? | Secrets it needs a human to set |
| --- | --- | --- |
| `extract-schedule` | **Live** (401) | `OPENAI_API_KEY` |
| `generate-howto` | **Live** (401) | `OPENAI_API_KEY` |
| `synthesize-type-tips` | **Live** (401) | `OPENAI_API_KEY` |
| `transcribe-install-memo` | **Live** (401) | `OPENAI_API_KEY` |
| `ask` | Not deployed (404) | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, optionally `ANTHROPIC_MODEL` |
| `extract-specs` | Not deployed (404) | `ANTHROPIC_API_KEY`, optionally `ANTHROPIC_MODEL` |
| `generate-toolbox-talk` | Not deployed (404) | `OPENAI_API_KEY` |
| `ingest-knowledge` | Not deployed (404) | `OPENAI_API_KEY` |
| `send-push` | Not deployed (404) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, optionally `VAPID_SUBJECT` |
| `vault-config` | Not deployed (404) | None beyond the automatic ones |

### The complete secret list, and which are automatic

Read directly from every `Deno.env.get` call in `supabase/functions/`:

| Secret | Where it is read | Who sets it |
| --- | --- | --- |
| `SUPABASE_URL` | `_shared/auth.ts` line 19, `_shared/openai.ts` line 4, `send-push/index.ts` line 21 | **Automatic.** Supabase injects this per project, so it corrects itself when a function moves |
| `SUPABASE_ANON_KEY` | `_shared/auth.ts` line 20 | **Automatic** |
| `SUPABASE_SERVICE_ROLE_KEY` | `_shared/openai.ts` line 6, `send-push/index.ts` line 22 | **Automatic** |
| `OPENAI_API_KEY` | `_shared/openai.ts` line 3, `ask/index.ts` line 575 | **By hand** |
| `ANTHROPIC_API_KEY` | `_shared/anthropic.ts` line 7 | **By hand** |
| `ANTHROPIC_MODEL` | `_shared/anthropic.ts` line 11 | Optional; defaults to `claude-sonnet-5` |
| `VAPID_PUBLIC_KEY` | `send-push/index.ts` line 23 | **By hand.** The same public value also goes in the app's own `VITE_VAPID_PUBLIC_KEY` |
| `VAPID_PRIVATE_KEY` | `send-push/index.ts` line 24 | **By hand.** Never in git |
| `VAPID_SUBJECT` | `send-push/index.ts` line 25 | Optional; defaults to `mailto:ops@infinitywindows.app` |

Two useful notes. First, **the three `SUPABASE_*` values are injected by the
platform**, so they are the one part of this that migrates itself — a function
deployed to Ammon's project automatically talks to Ammon's project. Second,
because `_shared/openai.ts` reads its values when the file loads, and almost
every function imports it, in practice **`OPENAI_API_KEY` should be set on
whichever project wins regardless of which functions you deploy first.**

The device PIN gate stores its data in the `vault_config` table, which has **0
rows**. So no PIN is currently set, and there is nothing to migrate — but the
PIN would need setting again on the new project.

### One more thing worth knowing before choosing

The database records **107 applied migrations, but the repository contains only
70 migration files.** Of the 37 extras, 26 were created by today's repair tooling
and 11 pre-date it. This is already documented and a cleanup script is waiting
for approval at `docs/migration-history-phantom-cleanup-2026-07-29.sql`, which is
deliberately **not run**. Those rows hold no application data, so nothing is at
risk — but it means **you cannot assume the repository's migration files fully
describe `czprjcskmzzagdztqonm`**, and it is a strong reason not to trust
`supabase db push` blindly against either project without a dry run first.

---

## 6. The three options, side by side

| | **(a) Keep `czprjcskmzzagdztqonm`, Ammon switches** | **(b) Switch to `jvsyhtarnvmdilsgksdi`, migrate our data in** | **(c) One is production, one is a sandbox** |
| --- | --- | --- | --- |
| **What data moves** | Nothing of ours. Whatever Ammon has built moves to us, and we cannot size that job because we cannot see it | 374 rows, 6 files (12.7 MB), 6 crew accounts re-invited | Nothing moves. Production keeps its data; the sandbox gets a copy or a fresh seed |
| **What breaks** | Ammon loses his working setup and re-does his work here. Nothing in the app or the deployment breaks | Six people sign in again with new passwords. Any planset not re-uploaded shows as listed-but-unopenable. Empty buckets must be created or the first photo upload fails | Nothing immediately. The ongoing risk is that people forget which is which, which is the exact problem we already had |
| **What must be reconfigured** | Nothing in the repository. Only the 3 missing GitHub secrets, which are needed either way | 9 repository files, 2 GitHub secrets reset, 3 GitHub secrets created, `app/.env` on every laptop, 4 storage buckets, 4 function secrets, 10 functions deployed, sign-in redirect URLs, and a rebuild | The repository points at production. The sandbox needs its own secrets, functions and buckets |
| **Rough effort** | **Hours** for us. Unknown for Ammon | **One to two days**, most of it verification rather than typing | **Half a day** to set up, then a permanent small tax on every change |
| **What is irreversible** | Nothing on our side. **Any work Ammon does not re-create is gone** | **The six old login accounts and their 8 active sessions.** Old passwords cannot be carried over. Everything else is recoverable from the committed JSON backup plus the four PDFs | Nothing, as long as nobody writes real work into the sandbox believing it is production |
| **The real risk** | We might be discarding more work than we are keeping. We genuinely do not know | We might be migrating into a database whose schema is behind ours, or whose data collides with ours. Also unknown | Two databases is what caused this. Formalising it makes the ambiguity permanent |

Two observations that cut across all three.

**The 31 empty tables added by today's repair do not affect this decision.** As
recorded in `docs/migration-repair-2026-07-29-production.md`, that work added 31
tables that all contain zero rows, deleted nothing, and wrote only four small
backfills. If `czprjcskmzzagdztqonm` is retired, the cost of that work having
been done is 31 unused empty tables in a database nobody uses. It is not a reason
to prefer option (a).

**Option (c) is worse than it looks.** The reason the app now shows a red "Wrong
database" banner is that two people worked against two databases for days and
nothing said so. A sandbox is a legitimate engineering practice, but it only
works when a mechanism enforces the distinction. Today the only mechanism is one
line in `app/src/lib/supabaseProject.ts` and a banner someone can ignore.

---

## 7. What we still do not know, and cannot find out from here

**Conclusion: every fact in this document is about `czprjcskmzzagdztqonm`. We
have no read access to `jvsyhtarnvmdilsgksdi` and made no attempt to force it.
The decision cannot responsibly be finalised until someone answers the questions
below.**

Open questions, all of which need read access to Ammon's project:

1. **How much data does it actually hold?** The same row-by-row count as section
   1. Specifically: how many `projects`, how many `project_openings`, how many
   `install_events`, how many `window_types`. **This is the question the whole
   decision turns on.** If Ammon's project has real install history and ours has
   none, that settles it.
2. **How many login accounts does it have, and whose?** If Ammon's project
   already contains accounts for Taylor and the crew, the hardest part of option
   (b) is already done. If it contains only Ammon, all six people must be
   invited.
3. **What is in its storage buckets?** Do the four buckets exist? Are there
   plansets or install photos in them? Photos in particular would be
   irreplaceable and would argue strongly for option (b).
4. **Does its data overlap ours?** Both projects may contain a "Pecan Valley
   Town Homes — Building 14". If so, migrating our 109 openings in would create
   duplicates, and someone has to decide which version is right. This is the
   single most likely way a migration goes wrong.
5. **Is its schema ahead of, behind, or level with the 70 migration files in this
   repository?** Section 5 shows the migration history on our side is already
   unreliable. If Ammon's project is behind, migrations must be pushed before any
   data lands, and that push must be dry-run first.
6. **Which of the ten edge functions are deployed on it, and are its secrets
   set?** Probing from outside would answer the first half.
7. **What is its anon key?** Needed for `app/.env.example` and the GitHub secret.
   Only someone with dashboard access can read it.

### How to unblock this in about ten minutes

The cheapest path is for **Ammon to add Taylor as a member of the
`jvsyhtarnvmdilsgksdi` project in the Supabase dashboard** (Project Settings,
then Team). That gives read access through the same tooling used to produce this
document, and section 1 through section 3 can then be reproduced for his project
so the two sit side by side with real numbers.

Until then, the honest position is: **`czprjcskmzzagdztqonm` remains what the
deployed app uses and nothing in it is at risk, so there is no urgency and no
reason to change anything today. But there is also no reason to invest further
effort in it.** The team should hold, get read access, and decide with numbers on
both sides rather than numbers on one.

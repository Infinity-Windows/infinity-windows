# Warehouse — tickets

From the grill of 2026-08-17. The model is settled in `CONTEXT.md` ("The warehouse") and ADR-0004; this is the build order. Each ticket ships on its own branch with tests, and each one leaves the app working.

Nothing here is started. Ticket 00 (the package map on the Warehouse page) is already merged — it explains the model, it does not implement it.

---

## The schema change, in one place

Five things are missing today. Tickets 01–05 add them.

| What's missing | Where it hurts |
| --- | --- |
| A mark has no home — `mark_code` is bare text in four tables | Nothing can be checked; a typo is a new mark forever |
| A package doesn't know which *piece* it is | Can't answer "2 of 3 here" or "where is #16's glass" |
| A package can only be in a container, never on a shelf | No way to record loose stock, which is the pile that gets lost |
| `movements` only accepts windows | No history for packages, containers or supplies |
| Supplies have no location and no quantity | Can't tell an installer where the caulk is |

---

## 01 — Marks get a home

**Why first:** everything downstream points at a mark, and right now there is nothing to point at.

Add `project_marks (id, project_id, mark_code, created_at)` with `unique (project_id, mark_code)`. Backfill from the distinct `(project_id, mark_code)` pairs already in `project_mark_specs`. Point `package_marks` at it with a real foreign key, replacing the loose text column.

Leave `project_mark_specs`, `project_mark_elevation_views` and `project_spec_discrepancies` on their natural key for now — converging them is a separate job with no user-facing payoff. Write that down in the migration so the next person knows it was a choice.

**Test:** a package cannot be tagged to a mark that doesn't exist on that job.

---

## 02 — A package knows which piece it is

`packages` gains:

- `part_index int` and `part_total int` — the `2` and the `3` of `#16 2/3`
- `part_type text` — checked against `frame | glass | panel | threshold | hardware | screen | other`
- `mfr_mark text` — the manufacturer's own number, recorded only when it differs from the plan mark

Tagging asks for all of it. Typing is the backbone; the label photo is a shortcut that a human confirms before it saves. Never build on the manufacturer's barcode.

**Test:** a package with no part number is treated as 1 of 1 and flagged "no part number on label" — receiving is never blocked.

---

## 03 — "2 of 3 here" and the Parts panel

The payoff ticket, and the first one an installer feels.

A read model over 01 + 02: for a unit, how many packages it should have (`part_total` off any tagged package), how many are tagged, and where each one is. Then the **Parts panel on the unit's own page** — one row per package: part number, what it is, sticker code, where it is now, when it last moved. Green "3 of 3 · all here" or amber "2 of 3 · hardware not arrived". A quiet line shows the manufacturer's number only when it differs.

Conflict handling: two packages claiming different totals for one unit never overwrite each other — the app flags "these labels disagree" and a foreman settles it.

**Test:** the app never claims a part is missing on a unit whose packages carry no total.

---

## 04 — A package carries its own location

`packages` gains `location_id` (a shelf slot) alongside `container_id`. Loose = neither.

`storage_containers` gains `parent_container_id` (a crate inside a conex) and `location_id` (a conex has a yard spot), with a constraint that a parent cannot itself have a parent — one level, no deeper.

One RPC: moving a container moves everything inside it, in a single action.

**Test:** moving a conex with a crate in it moves every package in both, and a crate cannot be put inside a crate.

---

## 05 — One movement log

`movements.window_id` becomes nullable; add `package_id`, `container_id`, `supply_id` and `from_container_id` / `to_container_id`, with a check that exactly one subject is set. Fold `package_events` into it and drop that table.

This is what makes "last moved Tuesday by Ammon" answerable for anything scannable, and what the search bar in ticket 08 promises.

**Test:** every write path — tag, store, move, check out, take a supply — leaves exactly one movement row.

---

## 06 — Status says condition, location says where

Retire `staged` and `loaded` from `windows.status`; they were answers to *where*. What's left is condition: `good | damaged | installed`. Drop `windows.location_id` once packages carry location.

Redefine the four count cards against location instead of status: **On hand · Not tagged · Loose · Damaged**. "Staged" does not come back.

**Test:** the count on each card and the rows behind it come from one definition (the existing `inventoryViews` pattern — keep it).

---

## 07 — Supplies become real

`supplies` gains `home_location_id`, `on_hand numeric`, `last_counted_at`. New `supply_takes (supply_id, project_id, qty, actor, created_at)`.

Taking is three taps and never requires a pull list. The count drops when someone takes, and is corrected by counting — always displayed as *"about 140 on hand · last counted Aug 3"*, never as a bare number. The existing pull list stays as **Request** (a foreman, ahead of time) beside **Take** (an installer, now); when a take matches the list it ticks off, and when it doesn't it's still recorded.

**Test:** the on-hand number is never shown without its last-counted date.

---

## 08 — The one Warehouse page

The union. A **Find** bar pinned at the top that accepts any identifier — job, mark, unit, sticker, conex, shelf — and returns the whole chain rather than a list of results. Below it, in the order the day runs:

**How it works** (the map, already built) → **Coming in** → **In storage** → **Going out** → **Supplies** → **Problems**

Every action opens over the page; nothing navigates away. Installers see Find, Going out and Supplies; foreman and up see all of it.

Then the menu collapses to one row: `Catalog` moves to Admin, `Slot labels` and sticker minting become actions inside the page, and `Storage`, `Scan`, `Cycle count`, `Receive` become sections. Supplies stays under Warehouse, as a section.

**Test:** the existing "every NAV destination has a door" test still passes after the rows are removed.

**Shipped 2026-08-17**, minus the status collapse — see 08b. The nav test's allowlist now names the five paths that lost menu rows but kept doors on the page, and a new test freezes the warehouse section at exactly one row.

---

## 08b — Retire the unit system's location model

Split out of 08 on the day, deliberately. Q35/Q37 settled that `windows.status`'s `staged`/`loaded` values and `windows.location_id` die "in the same PR that rebuilds those screens" — and that rebuild is the work: `Receive` (284 lines), `Scan` (132), `CycleCount` (170) and `InventoryList` (178) all read and write the unit location model today, daily.

Shipping the union page and rewriting those four screens in one PR would mean introducing the page everyone uses while simultaneously replacing the screens they use today. Staged instead: the page landed first, those screens stay reachable and working from its "Other tools" fold, and this ticket makes their flows package-first and then drops the columns.

Order: make Receive tag packages rather than log units → make Scan resolve a package first → make Cycle count count a container → repoint `InventoryList`/`inventoryViews` at packages → drop `staged`/`loaded` from the status check and `windows.location_id`.

### What actually happened when 08b was picked up (2026-08-17)

Two of those five turned out to be wrong, and the last one is blocked. Written down so nobody re-derives it:

- **"Make Scan resolve a package first" was already done.** `Scan.tsx` has handled `packageSerial` and `containerSerial` since the storage feature shipped.
- **The Find bar was the real gap, and it was a regression.** Ticket 08 promised (grill Q4) that one box takes "job code, mark, unit ID, short code, package LPN, container serial, rack slot" — it delivered neither unit IDs nor slots, *and* removed the old `UnitSearch` from the page. So the 11 real units and 46 real shelves became unfindable from the warehouse. Fixed here: Find now resolves a unit by id/short code/serial and a shelf by address, reading the unit's place out of the old system's own status vocabulary.
- **Dropping the columns is blocked, and not by code.** Production holds **11 windows (7 on shelves, 1 staged), 46 locations including 8 job staging bays — and 100 blank stickers with zero packages tagged.** Retiring the unit location model today would delete the only warehouse data that exists and replace it with an empty system.

**Two features have no package equivalent at all**, which the original ticket missed:

| Unit feature | Package equivalent |
| --- | --- |
| Job staging bays (`J-<JOBCODE>-A/B`, two-per-job guaranteed in the database, `suggest_location()`) | none — packages have `location_id` but no staging flow |
| Load-out / unload (`load_units`, `unload_units`, `'loaded'` → `'on_site'`) | none — no truck container, no jobsite unload |

**The precondition for 08b is usage, not code:** packages have to be carrying the warehouse before the units can stop. Concretely — tag a delivery, store it, check it out, and let the "not tagged" number fall. Then build the two missing flows above, migrate the handful of units, and only then drop `staged` / `loaded` / `windows.location_id`.

Until then the two systems coexist deliberately, and the Find bar is the seam that makes that invisible to whoever is holding the phone.

---

## 09 — Sticker minting gets a real form

Foreman and up only. Replace the browser `window.prompt` on the Storage hub — it can't be styled, behaves badly on a phone, and is the one piece of this that looks broken in a demo.

---

## 10 — It works in a conex

Reads first: cache every conex's contents before someone walks into a metal box with no signal. Writes queue through the existing outbox and show as done with a small "not sent yet" mark.

**Test:** tagging and checking out with the network off leaves the same records once it reconnects.

---

## 11 — A damage report can carry a photo

**Why:** the package map and the Damaged card both promised a photo the app never took. The words were corrected on 2026-08-17 — they say "a note" now, which is what actually happens. This ticket is for making the original promise true instead.

Today the arrival check is a Good/Damaged pair per package plus **one** optional note shared by the whole submission. `arrive_packages` opens a `damage` issue per package and stamps `created_by`, which is why "who reported it" was already real. There is nowhere to put a picture: `issues` has no photo column, and `attachments` cannot hold one either — `attachments_target` requires a `window_id` or an `install_event_id`, and a damaged package has neither.

Four pieces, and none of them work without the other three:

- **On the screen.** Tapping Damaged on a package row opens `PhotoCaptureSheet` in `mode="single"` — the same stamped rear-camera sheet the flashing phase-proof shot already uses, with the same file-picker fallback. Per package, not per submission: one shared note covering six broken packages is already the weak part of this screen, and one shared photo would be worse.
- **Where the file goes.** A private bucket scoped by project id, following `install-media` and `trip-attachments`. Uploads queue through the existing outbox (`enqueueUpload`) so this still works inside a conex — and the new op has to be added to the allowlist the runner actually reads, not only to the type union. That exact miss has already cost this repo a day.
- **Where the path is recorded.** A photo path column on `issues`, added the way `package_id` was in `20260827000000` and for the same reason. Widening `attachments_target` to accept an issue is the other option; pick one and write down in the migration which, and why.
- **Where it is seen.** `Issues.tsx` shows the note and the reporter today. A damage issue with a photo gets a thumbnail that opens in the photo viewer already on the page.

**Test:** an arrival check filed with a photo leaves that photo reachable from the issue it opened — and one filed without a photo still opens the issue, because damage reported with no picture beats damage never reported.

---

## Deliberately not doing yet

- Converging the other three `mark_code` tables onto `project_marks` (no user-facing payoff).
- Renaming the `packages` tables to say "package" everywhere the field does — accepted gap, recorded in ADR-0004.
- Reading expected parts off spec sheets. The manufacturer's `N of M` already answers it; revisit only if labels start arriving without part numbers.
- Multi-location supply counts. One home spot per supply until somebody is genuinely blocked by it.

---

# Round 2 — from the grill of 2026-08-18

The model is settled in `CONTEXT.md` ("The warehouse", updated the same day) and in ADR-0005 (one chain, planned per window number) and ADR-0006 (an area is a pointer, not a place). Same rules as round 1: each ticket ships on its own branch with tests, and each leaves the app working.

Order matters. 12–14 are the floor the others stand on; 21 is last on purpose; 22 is parked by owner decision until the physical slot reorganization.

## 12 — A container knows what it is

**Why first:** three later tickets branch on the kind of a container, and today every container is the same shape — which is how a crate ends up described as a conex on screen.

`storage_containers` gets `kind` (`conex | crate | truck | building`, default `conex` for the two existing rows), `length_cm / width_cm / height_cm / weight_kg` (nullable — dimensions are a crate's problem first). Seed one `building` row named "Main warehouse", idempotently — production already has 2 containers and this migration must not care whether it has run before. Nesting rules move onto kind: a conex nests in nothing, a crate rides in a conex or a truck, a building holds anything and sits in nothing. The New-container form gets a kind picker and, for crates, the dimension fields; every screen that says "conex" about a crate stops.

## 13 — Where a container has been is history

**Why:** the owner's conexes genuinely move between yard and jobs. Today the address is a text field somebody overwrites, which answers "where is Conex 7" and destroys "where was it last Tuesday" — the question that matters the first time material goes missing between two yards.

Changing a container's address writes a movement line (same log everything else uses) instead of silently editing the row. The `building` kind refuses moves and address changes outright. The container page grows a short trail — "Yard A since Aug 12 · BLACK22 before that." Find can then say "Conex 7 — at BLACK22" with a straight face.

## 14 — Where in the box: areas

**Why:** slots are parked, the reorganization needs rough position anyway, and "it's in Conex 7" is a five-minute hunt inside a forty-foot box.

`packages.area` (text, check-constrained). Foreman+ set it from the package sheet and the container page; the option list comes from the kind of the current container — Front / Middle / Back inside anything that moves, compass + Middle inside the building (ADR-0006). Every server-side move of the PACKAGE — store, checkout, stage — clears it in the same statement that moves it (a trigger, so every future writer is covered too). A container move deliberately does NOT clear the areas inside it: an area is relative to the box, and the package in the front of Conex 7 is still in the front when the conex arrives at the job. (Corrected from this ticket's first wording during implementation.) Find and the package sheet read "Conex 7 — front." Tests prove the clear on every move path, not just one.

## 15 — Plan a window's packages and mint its labels

**Why:** this is the merge (ADR-0005). Typing at a truck is where wrong data comes from; a label that already says BLACK22 · Window 16 · 2 of 4 turns receiving into sticking.

On a job's window (the mark page, foreman+): "arrives as N packages." Minting creates N package rows pre-bound — job, window, part i of N — in a pre-arrival state (**minted**) that the Tag screen's truck-side confirm flips to received; the batch prints in one go, formatted like the blank-roll stickers plus the binding line. (The first wording here said "the arrival check" — that screen is the JOB-site delivery check for checked-out material, not warehouse receiving. Corrected during implementation.) The blank-roll path stays for everything unplanned. The maker's printed "of M" still wins a disagreement with the declared N: the truck-side copy says so in words and never blocks. The "lands as a spec-review question" half moves to ticket 20 — the discrepancy table's kinds are a closed, check-constrained set from the plans-reconciliation domain, and widening it belongs with the mark-page work, not here. This ticket decides the pre-arrival state's name and lifecycle and writes it down — it is the one good idea the unit chain had, kept.

## 16 — Burn and Reprint

**Why:** the owner asked for burning directly; review split it in two so a coffee spill cannot erase a package's history.

Both foreman+. **Burn** (multi-select for a ruined batch): only while the package has no history; the serial dies, the part slot reopens, the warning is loud and names what it kills — "This throws away label 2 of 4 for Window 16. Destroy the paper — anything still wearing it will scan as nothing." **Reprint**: any real package, same serial, fresh paper, history intact, small warning to destroy the old sticker. Burn refuses a package with history and points at Reprint by name.

## 17 — The Boneyard

**Why:** the reorganization is mostly labeling stock that no job owns, and today the tag screen cannot express that — a job is required.

The tag screen's job dropdown gets "Boneyard — company stock, no job yet" (same access as tagging: whoever is at the truck). Picking it hides the window-number list; part fields stay; the label prints BONEYARD where the job code would go. `packages.project_id` becomes nullable with `bind_package` accepting the boneyard case explicitly. Everywhere the app would say "no job" about boneyard stock it says Boneyard instead — but NOT for a finished job's packages, which keep their job; conflating those two would recreate the F9 bug with friendlier words.

## 18 — Assign to job

**Why:** boneyard stock exists to be used; the exit has to be as deliberate as the entrance.

Foreman+ on the package page: pick job, pick window number, one movement line — "assigned to BLACK22 as Window 16" — and an offered, never required, fresh label. Putting material on a job changes what that job expects, which is why this is a decision and not a putaway.

## 19 — Splitting a unit warns and is counted

**Why (owner call):** warn, never block — a frame on site while its glass waits is sometimes the job — but a warning at the moment of the tap is seen by one person, so the standing state needs its own number.

At set-aside and checkout, when other parts of the same unit sit elsewhere: one-tap warning naming where the rest are ("Window 16's other 3 parts are in Conex 3"). On the warehouse page: a standing count of units currently split across places, built on the same read model as "2 of 3 here."

## 20 — An untagged window opens

**Why:** the Not-Tagged list is rows of dead text; a dead row teaches people the list is a dead end.

Each row opens its window: the opening page with the spec when one exists (marks map to openings the same way Maps Interactive maps them), and an honest "no spec page yet — spec review adds it" note when none does. Where the type is known it shows inline on the row, so the common question costs zero taps.

Also landed here, from 15: the maker-count disagreement got its column. `mfr_part_total` is what the maker's printed label claims; anyone at the truck records it from the package page ("The maker's label disagrees?"), and the parts math raises the flag everywhere parts already show — including the window's own spec page, which is what "lands as a spec-review question" turned out to honestly mean. The spec-discrepancy TABLE was the wrong landing spot: it stores acknowledgements of computed reconciliation findings, not findings themselves, so a row written there would have displayed nowhere.

## 21 — Retire the unit chain (deliberately last)

**Why last:** deleting the old chain while the new one is half-built leaves neither. This lands only after 15 has shipped and been used once in anger.

Receive rebuilds on packages (it becomes a thin door onto Tag/arrival). The pre-issue panel, the reconciliation, the `window_units` reads (inventory list included) all go in one pass; reads die first, the table survives one release as an archive, then drops. Production reality when written: 11 unit rows, all internal testing (ADR-0005).

**What the pass turned out to cover (2026-08-18):** deeper than written. The job page's whole warehouse tab was the unit LOAD flow (scan-onto-truck), and the overview stats counted units — both rebuilt in package terms (checkout is the load flow; "N packages on hand · M checked out"). "Needed (by type)" now counts an opening as on-hand only when every part is physically here. Slot search resolves through the locations themselves (finishing audit F7 — the old path answered only when a retired-chain unit was parked there). Scan answers old WIN labels honestly instead of a dead page. Deleted outright: Receive-as-intake, InventoryList, CycleCount, WindowDetail, pre-issue, reconciliation, unload, and their libs.

**Three reads deliberately survive until the table drops:** OpeningSheet's scan-assign (links a physical unit to an opening; still functional against the living table), the ReorderNeeds RPC (server-computed; rebuilt on packages when the table drops), and the pure loadout helpers behind it. The table itself was NOT dropped — that is the one-release archive this ticket promised, and the rollback if the package flow disappoints its first real truck.

## 22 — The warehouse map (unparked 2026-08-18, owner's word — building in three slices)

Original park: rides with the physical slot reorganization. The owner unparked it the same day; the three-slice order makes each piece useful alone.

**Slice 1 — shells and the link (SHIPPED).** `storage_containers.studio_project_id`, supervisor+ `set_container_model`, and a "3D shell" panel on the container page: real measurements in (a conex prefills the standard 20-foot box; the record learns the dims the moment they're typed), a true-dimension Studio project generated in the editor's own save format — the door end is +x, which the viewer's area glow will lean on — linked, and opened in Studio.

**Slice 2 — the shelf (next).** Studio's first free-standing object: a rack/shelf box with real dimensions, placed inside a shell. The vendored engine carries the machinery (OnFloorItem); the product wiring — palette, geometry, serialization round-trip — is the work. This is what makes the reorganization drawable.

**Slice 3 — the installer's view.** A read-only 3D viewer (installers never get the supervisor editor) where Find's "see it in 3D" glows the package's area zone — the +x third for "front", compass corners in the building — and real slots when slots exist.

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

---

## 09 — Sticker minting gets a real form

Foreman and up only. Replace the browser `window.prompt` on the Storage hub — it can't be styled, behaves badly on a phone, and is the one piece of this that looks broken in a demo.

---

## 10 — It works in a conex

Reads first: cache every conex's contents before someone walks into a metal box with no signal. Writes queue through the existing outbox and show as done with a small "not sent yet" mark.

**Test:** tagging and checking out with the network off leaves the same records once it reconnects.

---

## Deliberately not doing yet

- Converging the other three `mark_code` tables onto `project_marks` (no user-facing payoff).
- Renaming the `packages` tables to say "package" everywhere the field does — accepted gap, recorded in ADR-0004.
- Reading expected parts off spec sheets. The manufacturer's `N of M` already answers it; revisit only if labels start arriving without part numbers.
- Multi-location supply counts. One home spot per supply until somebody is genuinely blocked by it.

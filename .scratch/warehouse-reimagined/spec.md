# Warehouse, reimagined — spec

Status: approved (owner, 2026-09-06). Research artifact:
https://claude.ai/code/artifact/b125195b-6925-489a-901b-844c50d39d82
Evidence: `01-code-audit.md` (code, tap counts, dead code), `02-competitors.md`
(30 products), `03-open-source.md` (packages, repos, licences).

## The problem in one paragraph

The model underneath the warehouse is right — packages carry the sticker,
boxes hold packages, location is inherited, every write is a movement line,
Find answers "where is window 16" in one tap. What went wrong is on top of it:
eight menu rows became nineteen buttons on one page; the same edit (a part
label) lives on four screens and piece count on three; a package can never
change job (`assign_package_to_job` and `set_package_window` refuse); two
location models coexist (boxes vs slots and bays); five stage vocabularies;
the tailgate screen is online-only. Tap counts today: expected truck 40–62,
hand-logged truck ≈65, tag one package 10–12, move one package 4 plus a hunt.

## The model (unchanged nouns, five rules)

**Unit** — one opening on one job, named by its mark. Never moves. The unit
card is its ONE editor; every fact on it is a chip you tap to change.
**Package** — one physical piece of a unit, one sticker, one box. **Box** —
anything that holds packages (conex, crate, truck, trailer, building, and —
wave 5 — bay). **Event** — every write is one movement line, and every line
can be undone by writing its opposite.

1. Scan does the next thing (state-aware verb order, keep scanning = select).
2. Warn, never block — extended to changing a package's job or mark.
3. Ask "where in the box" once, at put-away, one optional tap on the picture.
4. Nothing is typed twice.
5. Bulk is the default: one selection bar (Move · Label · Job · Print · Delete).

## Decisions (all approved 2026-09-06)

1. A package may change job after tagging: yes, warning + movement line.
2. Staging bays become boxes of kind `bay`; the slot model retires (wave 5).
3. A 2D top-down yard map is the finder; the 3D viewer stays a viewer.
4. Area is asked at put-away, one optional tap; front/middle/back everywhere;
   the nine-button compass grid goes.
5. No paid scanner SDK yet; native BarcodeDetector + polyfill first, STRICH
   trial only if "scan a whole shelf" becomes a real ask.
6. No PowerSync for now; evaluate after wave 4.
7. Keep the five station words in copy; drop the numbered strip.

## Two additions (owner, 2026-09-06)

**Confirm without a sticker.** Every package already has a serial and a
six-character hand-writable short code (no O/0/I/1), Find already accepts
either typed, and expected packages exist before any sticker is printed — so
"the worker confirms it exists and moves it, with a unique ID" is a path, not
a system. The scan sheet gains **"No sticker? Type or pick"**: type the short
code, or pick job → window → piece (the maker's `#16 2/3` is itself unique
per job). A hand confirmation writes the same movement line, with
`reason` prefixed `by hand:` so the history says so. Industry name: manual
confirmation against a human-readable license plate. OCR of the maker's
printed label (tesseract.js) is a possible later step, not now.

**Copies.** Clone sets stay (×2–×20 identical units, each with its own
serial, stored by count — the interchangeable-pool model from PR #409). The
industry names for the two ways to track copies are *serial-tracked* (each
copy its own sticker) and *lot-tracked* (copies pooled under one ID, moved by
count). The unit card's **"Copy this unit ×N"** asks which: **each copy gets
its own sticker** (default, today's behaviour) or **no stickers — copies ride
on the original** (`packages.tracking = 'pooled'`: the original's sticker
prints `×N`, a scan of it asks "how many of the N?", every copy still has its
own serial so history stays per piece, and any copy can be given its own
sticker later with one tap — the reprint machinery). Both kinds carry unique
IDs; only the paper differs.

## Waves

| Wave | Delivers | Removes | Ticket |
| --- | --- | --- | --- |
| 1 · Fix the edits | `reassign_package` + `undo_movement` (20260994000000); the unit card `/unit/:job/:mark`; Undo toast on every warehouse write; history lines with Undo | Rewrite a set, PlanPackagesPanel's declare form, Fix things / Danger groups (follow-up PR, after #549 lands) | 01 |
| 2 · Scan first | One Scan button on every warehouse screen; the scan sheet; hand-confirm path; the one selection bar | Scan page, "scan a sticker onto the glowing line", Custom check-in | 02 |
| 3 · The yard | Home = yard map of boxes; Find answer with piece tiles + glowing box; box page with thirds | Station strip, count cards, container tiles, package-map fold, Other tools | 03 |
| 4 · The truck | Tailgate unit-first + offline; "+ not on the list"; load photo | Log-a-delivery wizard, Arrival check, Tag packages, Deliveries list | 04 |
| 5 · One model | Bays → boxes; slots retired; `category` dropped; `package_events` dropped; fallbacks + dead code deleted; 08b closed; pooled copies | — | 05 |

Sequencing rules: own worktree, port ≥ 5199, one browser-test slot; wave 1
does not touch `PackageSheet.tsx` until #549 (legacy-pickers-onto-hook) is on
master; migration numbers are claimed with the build session first.

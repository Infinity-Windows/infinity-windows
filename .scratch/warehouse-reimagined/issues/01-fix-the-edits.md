# 01 — Fix the edits: the unit card, reassign, undo

Status: ready-for-agent
Type: task
Size: M

## Build
- Migration `20260994000000_unit_card_edits.sql`: `movements.before`, `movements.undoes`, `reassign_package(p_package, p_project, p_mark, p_reason) → movement id`, `undo_movement(p_movement) → movement id`. No constraint or vocabulary changes.
- `pages/storage/UnitCard.tsx` at `/unit/:projectId/:mark` (`waiting` + `?pending=` for a job not built yet). Chips: job, window, count. Piece tiles toned here/expected/out. Selected-piece card: label chips, part number, note, move to window/job, photos link, foreman-only remove.
- Undo toast on reassign (server undo) and relabel (client inverse); history lines with Undo per `lib/warehouse/undo.ts`.
- Doors: Find's unit answer ("Open unit"), Job materials "Edit…".
- Tests: `undo.test.ts`, `UnitCard.test.tsx`, floors test lists `reassign_package` as open, e2e `unit-card.spec.ts`.

## Follow-up PR (after #549 lands)
- PackageSheet: "Open unit" link in the header; retire the Fix things / Danger groups.
- Retire Rewrite-a-set and PlanPackagesPanel's declare form; JobMaterials and DeliveryDetail "Edit set…" point at the unit card.
- "Copy this unit ×N" on the card with the sticker choice (spec, Two additions).

## Test
A package on BLACK22 window 16 moves to PECAN14 window 4 with one call and one movement line; Undo puts it back and the history shows both lines.

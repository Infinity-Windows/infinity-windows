# 05 — One model: bays become boxes, the duplicates go

Status: in-progress (slice A: dead code + deploy-window fallbacks deleted, /receive redirect; slice B: migration 0996 = packages.tracking + copy_unit + drop materialize_pending_set. DEFERRED, need a production probe + owner eyes first: bays → boxes (46 seeded slots), dropping `category`, dropping `package_events` (three scripts reference it), pending-job rows, one stage vocabulary)
Type: task
Size: M

## Build (one migration, mostly deletion)
- Staging bays become `storage_containers` of kind `bay`; `stage_packages` folds into `store_packages`; `locations`, `/labels`, `/loc/:address` retire; ticket 08b closes (`staged`/`loaded`/`windows.location_id`).
- `packages.category` dropped (part label is the one "what is it"); `package_events` dropped; every deploy-window fallback in `storage.ts` deleted; dead code from the audit deleted (`windowLabelsPdf`, `updateWindow`, `getMovements`, `receiveWindow`, `moveWindow`, `suggestLocation`, `materialize_pending_set`, `/receive`).
- "Not built yet" jobs become real `projects` rows in a `pending` state so a unit's job is always a chip; `pending_job_name` retires.
- `packages.tracking = 'serial' | 'pooled'` for copies that ride on the original (spec, Two additions); the original's sticker prints `×N`; a pooled copy promotes to its own sticker via reprint.
- One stage vocabulary in copy: expected · arrived · stored · out · installed, colour first.

## Test
Table count and `movementEvents`/`warehouseFloors` source tests updated; the anon probe stays green; every finder loses its container-or-location branch.

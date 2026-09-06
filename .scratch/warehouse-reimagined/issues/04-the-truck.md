# 04 — The truck: tailgate unit-first, offline, one door

Status: in-progress (slice A: unit-first rows + one put-away button + offline reads, PR pending; deferred: damage tap + photo per unit, "+ not on the list" card replacing the wizard, load photo/hauler on the delivery, retiring the wizard/arrival-check/tag/deliveries-list screens)
Type: task
Size: L

## Build
- Tailgate rebuilt one row per unit: tick a unit and every piece arrives; identical units are one row with a count; damage is one tap and a photo; one put-away button that names the box used last, "or tap a different box".
- Offline: `deliveries` and `deliveryPackages` in `OFFLINE_KEYS`; arrive and store through the outbox; a delivery row minted locally when none exists (fixes the first-tag-of-the-day failure).
- Unexpected truck: same screen, "+ not on the list" adds a unit with count and labels in one card — no wizard, nothing typed twice.
- Delivery record: load photo, hauler, discrepancy note.

## Removes
Log-a-delivery wizard, Arrival check page, Tag packages page, Deliveries list. Keeps expected lists, clone twins, crate pieces, the standby-list model.

## Test
With the network off, ticking a unit and tapping Put away queues `receive_minted_packages` + `store_packages`; reconnecting leaves the same rows as online.

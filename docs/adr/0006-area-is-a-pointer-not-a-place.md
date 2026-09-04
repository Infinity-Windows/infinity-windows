# An area is a pointer inside one box, not a place

Slots are deferred by owner decision until the physical warehouse reorganization — the 46 seeded slots have never held a package, and building creation UI for a layout about to be torn up would be building on sand. But the reorganization itself needs "roughly where in this box," and so does everyday putaway until then.

The obvious answers break on a fact settled the same day: **containers move, with history.** A package marked "NorthEast" inside Conex 7 is wrong the day a driver re-parks it facing south, and nothing in the app would know. The original ask — one list of eleven compass-and-depth options everywhere — puts a compass inside boxes that rotate, and the app would state the wrong answer with total confidence, which is the exact failure the warehouse audit was about.

Considered and rejected: **one flat list everywhere** (above). **Reusing the slot machinery** — a slot is an addressed record with its own label that packages point at; welding a rough pointer onto it would confuse the two forever and prejudge the reorganization. **Waiting for slots entirely** — leaves the reorganization untrackable, which is precisely when rough position matters most.

Chosen (owner call, 2026-08-18): a package carries an **area** — set by foreman and up, meaningful only inside its current container. The option list depends on what kind of box it is in: **Front / Middle / Back** for anything that moves (a conex has a door end, and the door end is the front wherever it is parked), the full compass plus Middle only inside the main warehouse, which never moves. **Every move clears it, with no prompt** — an area carried into a different box reads as an answer and is a lie. An area is not an address: nothing points at it, no label prints for it, and it dies with the move. Slots, when they come, are the opposite on every one of those counts — which is how you tell the two apart.

**ADR-0007 addendum (2026-09-04):** "set by foreman and up" is superseded —
any crew member sets an area now (see
[ADR-0007](0007-warehouse-actions-are-crew-actions.md)). Nothing else here
moves: an area is still a pointer and not a place, still meaningful only
inside its current box, still cleared by every move with no prompt, still has
no label printed for it. The rank was the one sentence in this decision that
was about who, rather than about what an area is.

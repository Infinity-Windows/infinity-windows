# Nothing stores its own location — a thing borrows the location of whatever holds it

Warehouse had grown two independent answers to "where is this window." Units carried a status (`inbound / in_warehouse / staged / loaded / installed / damaged`) and a rack-and-slot location with its own QR label. Packages, added later for conex tracking, carried their own status (`blank / received / stored / checked_out`) and a container. The only thing joining the two was `package_marks.mark_code` — a bare text column with no foreign key to anything, even though `mark_code` is the install domain's identifier used throughout `lib/install/*`. `WindowDetail` never mentioned packages or containers at all, so a unit's own sheet could not tell an installer the unit was sitting in Conex 3.

Nothing in the schema forbade the two answers from disagreeing, and the eight-row Warehouse menu was the visible symptom: no single screen could answer the question, because no single record held it.

Considered and rejected: **show both** — the fastest fix, and the one that produces two right answers on screen and a foreman who trusts neither. **Packages win, units lose their slots** — clean, but loose stock on shelves is real, and an app that denies it sends people back to keeping the warehouse in their head.

Chosen (owner call, 2026-08-17): **location is inherited, never stored.** A package's location is the container holding it. A unit's location is where its packages are — a unit is a bill of parts, not a thing that sits somewhere. Containers nest exactly one level (a crate inside a conex), and moving a container moves its contents in one action. There is one location answer because there is only one place it can come from.

The consequences are the point, and they are not small. `package_marks.mark_code` has to become a real link to units, with existing tagged packages backfilled. Unit status splits: condition (`good / damaged / installed`) stays on the unit, while `staged` and `loaded` are retired — they were answers to *where*, and where now has exactly one source. The four Warehouse count cards get redefined against location rather than status. The `movements` log widens from windows-only to cover packages, containers, and supplies, so "last moved Tuesday by Ammon" is answerable for anything scannable.

What made this affordable: the app has never shipped to installers (see ADR-0003), so the tagged packages being backfilled are internal testing data, not a live warehouse. This decision would be considerably more expensive a year from now.

One deliberate gap: the field, the UI, and this glossary say **package**; the database tables say `packages` and were never renamed to match — accepted rather than paying migration risk for a rename with no user-visible benefit.

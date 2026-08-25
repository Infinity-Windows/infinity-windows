-- One-off clean slate before the first hand-logged delivery (owner's
-- explicit yes, 2026-08-21 night: "everything that is currently in the app
-- in warehouse can be deleted. meaning the storage, not the conex's we have
-- made or the main warehouse").
--
-- Erased for good: every package that was ever tagged, received, stored or
-- checked out — and, by cascade, every movement row about them — plus the
-- old truckload records. KEPT: every container (conexes, crates, trucks,
-- the building) and its own movement history, all rack locations, all
-- supplies, and BLANK sticker rows. Blanks stay on purpose: they are
-- physical printed rolls in the warehouse, and deleting their rows would
-- turn real stickers into paper that scans as nothing.

delete from packages where status <> 'blank';

update packages set delivery_id = null where delivery_id is not null;

delete from package_deliveries;

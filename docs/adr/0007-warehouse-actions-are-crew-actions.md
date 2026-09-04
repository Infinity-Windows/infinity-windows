# Warehouse actions are crew actions

**Status: accepted (owner call, 2026-09-04).**

Every warehouse action shipped foreman-and-up. Minting labels, registering a
conex, saying where in the box a package sits, assigning Boneyard stock to a
job, setting a supply's home spot, logging a truck by hand, filing a takeoff,
rewriting a set — all of them drew the same line, and the line was drawn back
when "the warehouse" was one person's job.

It isn't. The person at the tailgate at 6am is an installer. So is the person
who carries the crate into the conex and knows it went at the back, and the
person who drives to the yard for one more tube of caulk. Every one of those
facts is known by somebody the app then told to go find a foreman. What
actually happens next is not that the foreman gets found: the fact goes
unrecorded, and the warehouse drifts. The rank stopped protecting the record
and started costing it.

Considered and rejected: **a "warehouse" flag on a person** — a fourth thing
to administer, and it would be handed to everybody within a month, which is
just this decision with extra paperwork. **Opening everything, destructive
doors included** — burn, delete and start-over end things, and "an installer
tapped delete" is a different kind of afternoon from "an installer set an
area". **Leaving it alone and training people to ask** — that is what has been
happening; the untagged count is the evidence.

Chosen: **any crew member may do the everyday warehouse work.** Two kinds of
door keep their rank, and they are the two the openness argument does not
reach:

- **Destructive — foreman and up.** `burn_packages`, `delete_packages`,
  `delete_delivery`. These END things: a serial that dies, a package whose
  history goes with it, a truck's expected list. "Start this set over" on the
  Rewrite-a-set screen is `delete_packages`, so it stays here too, and the
  screen says so in plain words rather than showing nothing.
- **Scheduling and settings — supervisor and up.** `schedule_delivery`,
  `save_checkout_reason`. Putting a truck on the company calendar and editing
  the company's reason list are office decisions that happen to live near the
  warehouse. They are not warehouse work.

Everything else opens: `mint_packages`, `mint_mark_packages`,
`add_project_mark`, `set_mark_part_total`, `save_storage_container`,
`set_package_area`, `set_package_window`, `assign_package_to_job`,
`add_supply`, `set_supply_home`, `create_takeoff`, `acknowledge_takeoff`,
`ready_takeoff`, `create_manual_delivery`, `file_pending_packages`,
`add_delivery_set`, `update_delivery`, `rewrite_set` — and the `takeoffs` /
`takeoff_items` read policies, which hid the shared warehouse inbox from the
people now working it.

**This supersedes the rank sentences, and only those, in ADR-0006 and
CONTEXT.md.** ADR-0006 said an area is "set by foreman and up"; everything
else it decided stands untouched — an area is still a pointer and not a place,
still meaningful only inside its current box, still cleared by every move,
still has no label printed for it. CONTEXT.md called Assign to job "the
foreman-and-up action"; it is any crew member's action now, and every refusal
it already carried does the real work.

**The partner wall had been leaning on the rank check, and now stands on its
own.** A builder login (ADR-wave S, `20260950000000`) carries
`role = 'installer'` with `profiles.is_partner` telling it apart, so the
foreman+ check was *also* what kept partners out of these RPCs. Dropping the
rank would have dropped that quietly. Every function opened in
`20260986000000` gains an explicit `is_partner_user()` refusal in the same
breath, and the two read policies keep theirs. Any future warehouse RPC has to
carry one too — the rank check is no longer there to do it by accident.

What this does not change: every validation, every refusal and every movement
line in those eighteen functions is byte-for-byte what it was. The only thing
that left is the question about rank. Nothing about mismatch, completeness,
part numbering, or the six package stages moved an inch.

Consequences worth naming. Installers now see the count cards, the container
list, and every takeoff rather than only their own — the shared warehouse
inbox is genuinely shared. `add_project_mark` was not on the original list and
had to open with the rest: the tag screen's "Add window N to the schedule"
button is that RPC, and an opened button in front of a closed door is worse
than no button. `materialize_pending_set` stayed foreman+ because nothing in
the app calls it; if a screen ever does, it belongs on the open side.

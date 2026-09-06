# One editor per unit, and an undo on every line

**Status: accepted (owner call, 2026-09-06).**

The warehouse audit of 2026-09-06 (`.scratch/warehouse-reimagined/01-code-audit.md`)
found the same edit living on four screens: a part label could be changed on
the package sheet behind two collapsed groups, on Rewrite-a-set, on the
delivery's row select, and in the container manifest's inline editor. Piece
count had three doors with three mental models. And the one edit a foreman
most obviously wants — *this box is tagged to the wrong job* — was refused
outright: `assign_package_to_job` only took Boneyard stock,
`set_package_window` only took marks on the package's own job, and the escape
hatch was foreman+ delete and re-tag, which throws away the history the
ledger exists to keep.

When one fact has four homes none of them feels like the right one, and
people learn that editing is scary. That is the whole of the owner's
complaint that the warehouse "feels over complicated, especially editing
units when they are prebuilt."

Considered and rejected: **tidy the four doors** (make them consistent) —
still four doors, and the refusal stays. **Allow reassignment as a foreman+
override** — the everyday mistake is caught by whoever is holding the box,
and ADR-0007 already settled that the warehouse is crew work. **A generic
database-level undo** (pgMemento, temporal tables) — heavier than the ledger
the app already has, and it would restore rows silently where the crew needs
to *see* that something was undone.

Chosen:

- **The unit card is the one editor.** `/unit/:job/:mark` shows a unit's
  pieces as tiles and every fact — job, window number, piece count, each
  piece's label, part number, note — as a chip you tap to change. Other
  screens link to it; they stop carrying editors of their own.
- **A package may change job or window.** `reassign_package` takes any job
  (or the Boneyard) and any window, adds a window not yet on the schedule in
  the same call, and writes one `assigned` movement line carrying where the
  package came from in `movements.before`. Warn, never block: the "different
  job" warning lives in the UI, the server records who, what and why.
- **Every line can be undone by writing its opposite.** `undo_movement`
  restores the state a line changed and writes an `override` line linked by
  `movements.undoes`. Nothing is edited or deleted — "moved here, then undone,
  by so-and-so" stays readable forever. The person who did it may undo it the
  same day; a foreman may undo any line at any time. Events the server does
  not know the opposite of refuse by name, and the client (`lib/warehouse/undo.ts`)
  mirrors the same rule so a button never sits in front of a closed door.
- **Every warehouse write shows the app's undo toast.** Writes that produce a
  movement line undo through `undo_movement`; pure-metadata writes (a part
  label) undo by re-writing the previous value from the client.

Consequences: `assign_package_to_job` and `set_package_window` stay as they
are for the screens that still call them, and retire with those screens.
Rewrite-a-set, the job page's plan-packages declare form, and the package
sheet's "Fix things" and "Danger" groups retire in the follow-up pass once the
unit card is the door everything points at. `movements` gains two nullable
columns and no constraint changes; the event vocabulary is untouched.

// Which history lines a person may undo, decided the way the server decides
// it (undo_movement, 20260994000000) so a button never sits in front of a
// closed door: the person who did it may undo it the same day, a foreman may
// undo any line at any time, an undo is never undone, and only the events
// the server knows the opposite of are offered at all.
//
// Pure: the unit card hands it a movement row, the clock, and who is asking.

export interface MovementLine {
  id: string;
  package_id: string | null;
  event: string;
  reason: string | null;
  actor: string | null;
  created_at: string;
  /** The line this one reversed, when it is an undo. */
  undoes: string | null;
  from_container_id?: string | null;
  to_container_id?: string | null;
}

/** How long the person who did it keeps their own Undo — one working day. */
export const UNDO_SELF_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The events undo_movement knows the opposite of. Everything else refuses
 *  by name on the server, so the button is not shown. */
export const UNDOABLE_EVENTS = ["assigned", "stored", "checked_out"] as const;

export type UndoVerdict = { ok: true } | { ok: false; why: string };

export function canUndo(
  line: MovementLine,
  args: { now: Date; me: string | null; foremanPlus: boolean; undoneIds: Set<string> },
): UndoVerdict {
  if (line.undoes) return { ok: false, why: "This line is itself an undo." };
  if (args.undoneIds.has(line.id)) return { ok: false, why: "Already undone." };
  if (!(UNDOABLE_EVENTS as readonly string[]).includes(line.event)) {
    return { ok: false, why: "This kind of line can't be undone yet." };
  }
  const mine =
    args.me != null &&
    line.actor === args.me &&
    args.now.getTime() - new Date(line.created_at).getTime() < UNDO_SELF_WINDOW_MS;
  if (mine || args.foremanPlus) return { ok: true };
  return {
    ok: false,
    why: "Only the person who did this can undo it today. A foreman can undo it any time.",
  };
}

/** Ids of lines that already have an undo written against them. */
export function undoneIds(lines: MovementLine[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) if (l.undoes) out.add(l.undoes);
  return out;
}

/** Plain words for a history line: the reason when there is one, else the
 *  event. Undo lines already start with "undone:". */
export function lineText(line: MovementLine): string {
  if (line.reason) return line.reason;
  switch (line.event) {
    case "stored":
      return "put away";
    case "checked_out":
      return "checked out";
    case "assigned":
      return "job or window changed";
    case "bound":
      return "tagged";
    case "override":
      return "corrected";
    default:
      return line.event.replace(/_/g, " ");
  }
}

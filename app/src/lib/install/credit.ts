// Who gets the credit for an install (wave Y, transcripts-program-spec).
//
// An install used to be filed under whoever pressed Submit. That is the right
// answer nearly every time and the wrong one the rest: a foreman finishing a
// unit for an installer whose phone died put the window on his OWN record —
// his median, his fail rate, the numbers dispatch ranks him on — and took it
// off the person who actually stood on the ladder.
//
// Credit is about the RECORD, never about time: the finisher's session stays
// the finisher's, because sessions follow the human (CONTEXT.md, "Session").
//
// This file is the CLIENT half of the rule, and it exists so the sheet can
// offer only choices the server will accept — nobody should meet a refusal
// after tapping Submit. The server's `credit_refusal` (20260982000000) is the
// real gate; these two say the same thing on purpose, and if one changes the
// other has to change with it.

/** A person the picker can offer, in the shape both the sheet and the map have. */
export interface CreditCandidate {
  id: string;
  name: string;
  role?: string | null;
}

export interface CreditChoicesInput {
  /** The signed-in person, or null while the profile read is still in flight. */
  meId: string | null;
  /** Who this unit is assigned to, if anyone. */
  assignedTo: string | null;
  /** Foreman and above may credit anybody on the crew. */
  canCreditAnyone: boolean;
  /** The active crew, already filtered by the caller. */
  crew: readonly CreditCandidate[];
}

/**
 * True when the finish step should ASK who installed this.
 *
 * Only when the unit is somebody else's: finishing your own unit is the
 * ordinary case and must stay one tap. A unit with no assignee is nobody
 * else's either — there is nothing to be wrong about.
 */
export function shouldAskWhoInstalled(input: {
  meId: string | null;
  assignedTo: string | null;
}): boolean {
  if (!input.meId || !input.assignedTo) return false;
  return input.assignedTo !== input.meId;
}

/**
 * The people this person may file the install under, in reading order:
 * the assignee first (the likeliest answer, and the default), then me, then
 * everybody else on the crew for a foreman and above.
 *
 * Never contains the same person twice, and never contains somebody the crew
 * list does not know — the server refuses those, so offering one would be a
 * button that fails.
 */
export function creditChoices(
  input: CreditChoicesInput,
): CreditCandidate[] {
  const { meId, assignedTo, canCreditAnyone, crew } = input;
  const byId = new Map(crew.map((c) => [c.id, c]));
  const out: CreditCandidate[] = [];
  const push = (id: string | null) => {
    if (!id || out.some((c) => c.id === id)) return;
    const found = byId.get(id);
    if (found) out.push(found);
  };
  push(assignedTo);
  push(meId);
  if (canCreditAnyone) for (const c of crew) push(c.id);
  return out;
}

/**
 * Who the picker starts on: the assignee when there is one, because the unit
 * was given to them and the overwhelmingly likely truth is that they did it.
 * Falls back to me when the assignee is not somebody the crew list knows.
 */
export function defaultCredit(input: {
  meId: string | null;
  assignedTo: string | null;
  choices: readonly CreditCandidate[];
}): string | null {
  const { meId, assignedTo, choices } = input;
  if (assignedTo && choices.some((c) => c.id === assignedTo)) return assignedTo;
  if (meId && choices.some((c) => c.id === meId)) return meId;
  return choices[0]?.id ?? null;
}

/**
 * What actually goes on the wire: null when the credited person IS the filer,
 * because that is what a null `credited_to` already means. Sending it spelled
 * out would give one fact two spellings and every reader a choice to get
 * wrong — the server normalises it too, and this keeps the ordinary finish on
 * the narrow fifteen-argument call a phone behind the migration can still make.
 */
export function creditToSend(input: {
  meId: string | null;
  creditedTo: string | null;
}): string | null {
  const { meId, creditedTo } = input;
  if (!creditedTo) return null;
  if (meId && creditedTo === meId) return null;
  return creditedTo;
}

/**
 * The line the Record reads back: "Installed by Sam · filed by Jed" when
 * somebody filed for somebody else, and just the installer otherwise.
 *
 * `installer` is the free-text name the field typed at file time and is what
 * the Record has always shown; the ids are only consulted when they disagree,
 * so a round filed before this column existed reads exactly as it always did.
 */
export function creditLine(
  event: {
    installer: string | null;
    installer_id?: string | null;
    credited_to?: string | null;
  },
  nameOf: (profileId: string) => string | null | undefined,
): string | null {
  const credited = event.credited_to ?? null;
  const filerName = event.installer ?? (event.installer_id ? nameOf(event.installer_id) : null);
  if (!credited) return filerName || null;
  const creditedName = nameOf(credited) || "someone else";
  if (!filerName) return `Installed by ${creditedName}`;
  return `Installed by ${creditedName} · filed by ${filerName}`;
}

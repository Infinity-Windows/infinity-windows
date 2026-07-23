// Pure push-recipient resolution for the job chat. Kept dependency-free and
// unit-tested so the notification rules are provably correct:
//
//   * Assigned crew (installers + foreman on the job) get a push on EVERY
//     message.
//   * Supervisors/owners get NO push for a normal message — only when they are
//     @-mentioned by name.
//   * @-mentioning anyone (assigned crew OR a supervisor/owner) also notifies
//     that person.
//   * The author never gets pushed for their own message.
//
// Net: recipients = assignedCrew ∪ mentioned, minus the author. A
// supervisor/owner who is not assigned appears only if mentioned.

export interface RecipientInput {
  /** Installers + foreman assigned to the job — always pushed. */
  assignedCrewIds: readonly string[];
  /**
   * Supervisors/owners who can view any job's chat. Passed for clarity: they
   * are only pushed when their id also appears in `mentionedIds`.
   */
  supervisorOwnerIds: readonly string[];
  /** Profile ids @-mentioned in this message — always pushed. */
  mentionedIds: readonly string[];
  /** The message author; never pushed for their own message. */
  authorId?: string | null;
}

/**
 * Resolve the set of profile ids to send a push to for a new chat message.
 * Returns de-duplicated ids in a stable order (assigned crew first, then any
 * additional mentioned people), excluding the author.
 */
export function resolvePushRecipients(input: RecipientInput): string[] {
  const { assignedCrewIds, mentionedIds, authorId } = input;
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (id: string) => {
    if (!id || id === authorId || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };

  for (const id of assignedCrewIds) add(id);
  // Mentioned people (including supervisors/owners not on the crew) are added
  // if not already covered by the assigned crew.
  for (const id of mentionedIds) add(id);

  return result;
}

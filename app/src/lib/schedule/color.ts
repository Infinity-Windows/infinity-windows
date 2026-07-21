// Color-by-crew. Each assignment gets a stable color from the shared installer
// palette so the same crew reads the same on every view. Draft/published/
// conflict styling is layered on top in CSS (dashed vs. solid vs. red outline).

import { INSTALLER_PALETTE } from "../install/mapDispatch";

/** Deterministic hash so a color key always maps to the same palette slot. */
function hashKey(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * The color key for an assignment: its first foreman (so a crew led by the same
 * foreman shares a hue), else its first member, else the assignment id.
 */
export function assignmentColorKey(assignment: {
  id: string;
  members: { profile_id: string; role: string }[];
}): string {
  const foreman = assignment.members.find((m) => m.role === "foreman");
  if (foreman) return foreman.profile_id;
  if (assignment.members.length > 0) return assignment.members[0].profile_id;
  return assignment.id;
}

/** Stable palette color for a key. */
export function colorForKey(key: string): string {
  return INSTALLER_PALETTE[hashKey(key) % INSTALLER_PALETTE.length];
}

/** An assignment's block color: an explicit override, else color-by-crew. */
export function assignmentColor(assignment: {
  id: string;
  color?: string | null;
  members: { profile_id: string; role: string }[];
}): string {
  return assignment.color || colorForKey(assignmentColorKey(assignment));
}

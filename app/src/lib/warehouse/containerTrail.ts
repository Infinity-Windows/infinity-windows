// The sentences a container's trail is made of (ticket 13).
//
// A trail line answers "what happened" in the words a foreman would use, off
// one movements row. Address changes already carry their whole story in
// `reason` ("address changed: Yard A → BLACK22") because the writer put it
// there; nesting and slot moves carry ids, so the words are built here.
//
// Pure and exported so the tests can prove every shape of row reads as a
// sentence — the raw-word history entries on the package sheet (audit F9) are
// the failure this file exists to not repeat.

import type { ContainerMovementRow, StorageContainer } from "../storage";
import type { Location } from "../types";

export interface TrailLine {
  id: string;
  when: string;
  text: string;
}

export function containerTrailLine(
  m: ContainerMovementRow,
  containersById: Map<string, StorageContainer>,
  locationsById: Map<string, Location>,
): TrailLine {
  const name = (id: string | null) =>
    id ? (containersById.get(id)?.name ?? "another container") : null;
  const slot = (id: string | null) =>
    id ? (locationsById.get(id)?.address ?? "a slot") : null;

  // The writer already said it in words — an address change, or any future
  // reasoned move. The reason IS the sentence.
  if (m.reason) return { id: m.id, when: m.created_at, text: m.reason };

  const to = name(m.to_container_id) ?? slot(m.to_location_id);
  const from = name(m.from_container_id) ?? slot(m.from_location_id);
  if (to && from) return { id: m.id, when: m.created_at, text: `moved from ${from} to ${to}` };
  if (to) return { id: m.id, when: m.created_at, text: `moved into ${to}` };
  if (from) return { id: m.id, when: m.created_at, text: `taken out of ${from}, on its own now` };
  return { id: m.id, when: m.created_at, text: "moved" };
}

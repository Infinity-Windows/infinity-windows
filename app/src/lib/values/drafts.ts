/** Owner-bound values drafts. A stable request id survives reloads and lost replies. */
import { IndexedDbOutboxStore, MemoryOutboxStore, valuesDraftKey, type ValuesDraftRow } from "../offline/outboxStore";
import { VALUE_SLUGS } from "./rubric";

const store = typeof indexedDB === "undefined" ? new MemoryOutboxStore() : new IndexedDbOutboxStore();

export function newValuesDraft(ownerId: string, assignmentId: string, rubricVersion: number): ValuesDraftRow {
  return {
    id: valuesDraftKey(ownerId, assignmentId), ownerId, assignmentId,
    requestId: crypto.randomUUID(), rubricVersion, scores: {}, comment: "",
    status: "editing", updatedAt: Date.now(),
  };
}

export async function loadValuesDraft(ownerId: string, assignmentId: string, rubricVersion: number): Promise<ValuesDraftRow> {
  const saved = await store.getValuesDraft(ownerId, assignmentId);
  if (saved) {
    if (saved.rubricVersion !== rubricVersion && saved.status !== "accepted") return { ...saved, status: "blocked" };
    if (saved.status === "queued") {
      const entry = (await store.getAll()).find((row) => row.id === saved.requestId && row.ownerId === ownerId);
      if (entry?.status === "failed") {
        return {
          ...saved,
          status: entry.lastError === "Values review conflict" ? "conflict"
            : entry.lastError === "Values review access denied" ? "denied" : "blocked",
        };
      }
    }
    return saved;
  }
  return newValuesDraft(ownerId, assignmentId, rubricVersion);
}

export async function saveValuesDraft(draft: ValuesDraftRow): Promise<void> {
  if (draft.id !== valuesDraftKey(draft.ownerId, draft.assignmentId)) throw new Error("Invalid review owner");
  await store.putValuesDraft({ ...draft, updatedAt: Date.now() });
}

export function allValuesScored(scores: Record<string, number>): boolean {
  return VALUE_SLUGS.every((slug) => Number.isInteger(scores[slug]) && scores[slug] >= 1 && scores[slug] <= 10)
    && Object.keys(scores).length === VALUE_SLUGS.length;
}

export async function readValuesStatus(ownerId: string, assignmentId: string): Promise<ValuesDraftRow["status"] | null> {
  const saved = await store.getValuesDraft(ownerId, assignmentId);
  return saved ? (await loadValuesDraft(ownerId, assignmentId, saved.rubricVersion)).status : null;
}

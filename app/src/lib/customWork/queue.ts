import { getWorkUnit, sendWorkCommand } from "./api";
import type { WorkCommand } from "./model";
import { markCompleteUnit } from "./complete";
import { formatApiError } from "../errors";
import { isNetworkError } from "../offline/outbox-core";

const prefix = "forge-custom-work-v1:";
export const WORK_QUEUE_EVENT = "forge:custom-work-queue";
export function readWorkQueue(userId: string): WorkCommand[] {
  const value = localStorage.getItem(prefix + userId);
  if (!value) return [];
  const parsed = JSON.parse(value) as WorkCommand[];
  if (
    !Array.isArray(parsed) ||
    parsed.some((c) => c.userId !== userId || !c.id || !c.action || !c.data)
  )
    throw new Error(
      "Saved work could not be read. Keep this device for recovery.",
    );
  return parsed;
}
function saveQueue(userId: string, rows: WorkCommand[]) {
  // A full/quota-denied store throws BEFORE the UI claims the timer was saved.
  localStorage.setItem(prefix + userId, JSON.stringify(rows));
  window.dispatchEvent(new Event(WORK_QUEUE_EVENT));
}
async function locked<T>(user: string, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely save work across tabs. Update the browser before starting.",
    );
  return navigator.locks.request(prefix + user, fn);
}
export async function enqueueWork(c: WorkCommand) {
  await locked(c.userId, async () => {
    const rows = readWorkQueue(c.userId);
    if (!rows.some((r) => r.id === c.id)) saveQueue(c.userId, [...rows, c]);
  });
}
/** Several dependent changes in ONE write. "Unit complete" is a stop followed
 * by the unit's complete mark, and both must be on the device before anything
 * waits on the network: when the mark was queued only after the stop's reply,
 * closing the app on weak signal kept the stop and lost the mark (Codex review
 * of #648, 2026-09-24). */
export async function enqueueWorkBatch(cs: WorkCommand[]) {
  if (!cs.length) return;
  const user = cs[0].userId;
  if (cs.some((c) => c.userId !== user))
    throw new Error("A set of work changes must belong to one account.");
  await locked(user, async () => {
    const rows = readWorkQueue(user);
    const fresh = cs.filter((c) => !rows.some((r) => r.id === c.id));
    if (fresh.length) saveQueue(user, [...rows, ...fresh]);
  });
}
const unitChanged = (e: unknown) =>
  String((e as { message?: unknown } | null)?.message ?? e).includes("Unit details changed");
/** A completion refused because the unit changed since this phone read it:
 * rebuild it from the server's latest copy, changing ONLY the complete mark,
 * so another person's edits are never overwritten. `null` = already complete,
 * nothing left to send; `undefined` = cannot rebuild, keep the refusal. */
async function rebuildCompletion(c: WorkCommand): Promise<WorkCommand | null | undefined> {
  const unit = await getWorkUnit(String(c.data.id));
  if (!unit) return undefined;
  if (unit.facts.installation_complete === "Yes") return null;
  return { ...c, id: crypto.randomUUID(), data: markCompleteUnit(unit), rebased: true, error: undefined };
}
export async function syncWork(user: string): Promise<boolean> {
  return locked(user, async () => {
    let rows = readWorkQueue(user);
    while (rows.length) {
      if (!navigator.onLine) return false;
      const c = rows[0];
      if (c.error) return false;
      try {
        await sendWorkCommand(c);
      } catch (e) {
        const message = formatApiError(e);
        // Network errors remain retryable. A refused command stays intact for review.
        if (isNetworkError(e)) return false;
        if (c.intent === "complete-unit" && !c.rebased && unitChanged(e)) {
          let rebuilt: WorkCommand | null | undefined;
          try {
            rebuilt = await rebuildCompletion(c);
          } catch (readError) {
            if (isNetworkError(readError)) return false;
            rebuilt = undefined;
          }
          if (rebuilt !== undefined) {
            rows = rebuilt === null ? rows.slice(1) : [rebuilt, ...rows.slice(1)];
            saveQueue(user, rows);
            continue;
          }
        }
        saveQueue(user, [{ ...c, error: message }, ...rows.slice(1)]);
        return false;
      }
      rows = rows.slice(1);
      saveQueue(user, rows);
    }
    return true;
  });
}
export async function retryWork(user: string) {
  await locked(user, async () =>
    saveQueue(
      user,
      readWorkQueue(user).map((c) => ({ ...c, error: undefined })),
    ),
  );
  return syncWork(user);
}
/** Keep a refused request downloadable; dropping it is explicit and never changes payroll. */
export async function discardWorkQueue(user: string) {
  await locked(user, async () => saveQueue(user, []));
}
/**
 * Drop ONE queued request by id, leaving everything behind it in place. For
 * the one refusal that has nothing to review — a start Forge turned away
 * because today's toolbox talk is not signed (see useWork.command): nothing
 * was written, and a retry after signing would carry the unsigned tap's time.
 */
export async function dropWorkCommand(user: string, id: string) {
  await locked(user, async () =>
    saveQueue(
      user,
      readWorkQueue(user).filter((c) => c.id !== id),
    ),
  );
}

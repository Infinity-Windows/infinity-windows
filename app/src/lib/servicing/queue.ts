import { sendServiceCommand } from "./api";
import type { ServiceCommand } from "./model";
import { formatApiError } from "../errors";
import { isNetworkError } from "../offline/outbox-core";

const prefix = "forge-servicing-v1:";
export const SERVICE_QUEUE_EVENT = "forge:service-queue";
export function readServiceQueue(userId: string): ServiceCommand[] {
  const value = localStorage.getItem(prefix + userId);
  if (!value) return [];
  const parsed = JSON.parse(value) as ServiceCommand[];
  if (
    !Array.isArray(parsed) ||
    parsed.some((c) => c.userId !== userId || !c.id || !c.action || !c.data)
  )
    throw new Error(
      "Saved service work could not be read. Keep this device for recovery.",
    );
  return parsed;
}
function saveQueue(userId: string, rows: ServiceCommand[]) {
  // A full/quota-denied store throws BEFORE the UI claims the timer was saved.
  localStorage.setItem(prefix + userId, JSON.stringify(rows));
  window.dispatchEvent(new Event(SERVICE_QUEUE_EVENT));
}
async function locked<T>(user: string, fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely save work across tabs. Update the browser before starting.",
    );
  return navigator.locks.request(prefix + user, fn);
}
export async function enqueueService(c: ServiceCommand) {
  await locked(c.userId, async () => {
    const rows = readServiceQueue(c.userId);
    if (!rows.some((r) => r.id === c.id)) saveQueue(c.userId, [...rows, c]);
  });
}
export async function syncService(user: string): Promise<boolean> {
  return locked(user, async () => {
    let rows = readServiceQueue(user);
    while (rows.length) {
      if (!navigator.onLine) return false;
      const c = rows[0];
      if (c.error) return false;
      try {
        await sendServiceCommand(c);
      } catch (e) {
        const message = formatApiError(e);
        // Network errors remain retryable. A refused command stays intact for review.
        if (isNetworkError(e)) return false;
        saveQueue(user, [{ ...c, error: message }, ...rows.slice(1)]);
        return false;
      }
      rows = rows.slice(1);
      saveQueue(user, rows);
    }
    return true;
  });
}
export async function retryService(user: string) {
  await locked(user, async () =>
    saveQueue(
      user,
      readServiceQueue(user).map((c) => ({ ...c, error: undefined })),
    ),
  );
  return syncService(user);
}
/** Keep a refused request downloadable; dropping it is explicit and never changes payroll. */
export async function discardServiceQueue(user: string) {
  await locked(user, async () => saveQueue(user, []));
}

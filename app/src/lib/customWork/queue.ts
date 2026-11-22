import { getWorkUnit, sendWorkCommand } from "./api";
import { UNIT_NOT_CREATED } from "../installerWorkflow/queuedUnits";
import { clockShiftResolver, isPendingRef } from "../offline/shiftResolver";
import { previewCommands, workAwaitingShiftReview, type WorkCommand, type WorkSession } from "./model";
import { markCompleteUnit } from "./complete";
import { formatApiError } from "../errors";
import { isNetworkError } from "../offline/outbox-core";
import { isToolboxGateError } from "../install/installTimer";

const prefix = "forge-custom-work-v1:";
const activityRetryDelays = [1000, 2000, 4000];
export const WORK_QUEUE_EVENT = "forge:custom-work-queue";
export const WORK_COMMAND_SENT = "forge:custom-work-command-sent";
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
function nextWorkIndex(rows: WorkCommand[]) {
  const awaitingReview = workAwaitingShiftReview(rows);
  // A refused change waits for review and does not hold up what was recorded
  // after it (Matt, 2026-11-20: "we dont want to block the picker… we just
  // don't want to miss things, overlaps are better"). Each later change goes
  // to Forge as it was recorded; one that depended on the refused change is
  // refused in turn and kept for review beside it.
  return rows.findIndex(command => !awaitingReview.has(command.id) && !command.error);
}
export function nextWorkRetryAt(rows: WorkCommand[]) {
  const command = rows[nextWorkIndex(rows)];
  return command?.error ? undefined : command?.retry?.notBefore;
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

/** Persist the activity/machinery stop before recording a paid-clock boundary. */
export async function stopWorkForClock(user: string, sessions: WorkSession[], at: string, afterOutbox: string[] = []) {
  return locked(user, async () => {
    const rows = readWorkQueue(user);
    const active = previewCommands([], sessions, rows).sessions.find(session =>
      session.profile_id === user && !session.ended_at && session.started_at <= at);
    if (active) {
      rows.push({
        id: crypto.randomUUID(), userId: user, action: "stop", afterOutbox,
        data: { expected_session_id: active.id, at, outcome: "partial", delay_reason: "" },
      });
      saveQueue(user, rows);
    }
    return nextWorkIndex(rows) >= 0;
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
/** Replay work up to a paid-clock boundary before that punch closes its shift. */
export async function syncWork(user: string, beforeAt?: string): Promise<boolean> {
  if (!navigator.locks) throw new Error("This browser cannot safely sync saved work.");
  // Network waits use a separate lock. Saving the next tap must remain quick.
  return navigator.locks.request(prefix + user + ":send", async () => {
    while (navigator.onLine) {
      const rows = await locked(user, async () => readWorkQueue(user));
      const index = nextWorkIndex(rows);
      const c = rows[index];
      if (!c) return rows.length === 0;
      if (c.error || (c.retry && c.retry.notBefore > Date.now())) return false;
      if (beforeAt && typeof c.data.at === "string" && c.data.at > beforeAt) return true;
      if (c.afterOutbox?.some(id => !clockShiftResolver.resolve("workday-after:" + id))) return false;
      let sending = c;
      if (c.action === "start" && typeof c.data.shift_id === "string" && isPendingRef(c.data.shift_id)) {
        const shift = clockShiftResolver.resolve(c.data.shift_id);
        if (!shift) return false;
        const clockInAt = c.data.workday_from_clock_in ? clockShiftResolver.clockInAt?.(c.data.shift_id) : null;
        // The server may use its timestamp when it cannot trust an offline tap.
        // Use its full precision when both values fall in the same millisecond.
        const at = clockInAt && typeof c.data.at === "string" && Date.parse(clockInAt) >= Date.parse(c.data.at)
          ? clockInAt : c.data.at;
        sending = { ...c, data: { ...c.data, shift_id: shift, at } };
      }
      const replace = (replacement: WorkCommand | null) => locked(user, async () => {
        const current = readWorkQueue(user);
        const position = current.findIndex(command => command.id === c.id);
        if (position < 0) return;
        current.splice(position, 1, ...(replacement ? [replacement] : []));
        saveQueue(user, current);
      });
      try {
        await sendWorkCommand(sending);
      } catch (e) {
        const message = formatApiError(e);
        if (c.action === "workday_activity") {
          if (!navigator.onLine) return false;
          const failures = c.retry?.failures ?? 0;
          const delay = activityRetryDelays[failures];
          await replace(delay === undefined ? { ...c, retry: undefined, error: message }
            : { ...c, retry: { failures: failures + 1, notBefore: Date.now() + delay } });
          if (delay !== undefined) return false;
          continue;
        }
        if (isNetworkError(e)) return false;
        if (c.action === "unit_create") {
          // Forge would not create the unit. The time clocked on it must not
          // be lost or held up behind it (Matt, 2026-11-20), so the creation
          // is dropped and the work record that pointed at the unit is kept
          // on its own, named so a foreman can find it in Activities.
          const failedUnit = String(c.data.id);
          await locked(user, async () => saveQueue(user, readWorkQueue(user).flatMap(command =>
            command.id === c.id ? []
              : command.action === "unit" && command.data.opening_id === failedUnit ? [{
                  ...command,
                  data: {
                    ...command.data, opening_id: null,
                    label: `${String(command.data.label ?? c.data.code)} (${UNIT_NOT_CREATED})`,
                    facts: { ...(command.data.facts as Record<string, unknown> | undefined), unit_not_created: message },
                  },
                }]
              : [command])));
          window.dispatchEvent(new CustomEvent<WorkCommand>(WORK_COMMAND_SENT, { detail: sending }));
          continue;
        }
        if (c.intent === "complete-unit" && !c.rebased && unitChanged(e)) {
          let rebuilt: WorkCommand | null | undefined;
          try {
            rebuilt = await rebuildCompletion(c);
          } catch (readError) {
            if (isNetworkError(readError)) return false;
            rebuilt = undefined;
          }
          if (rebuilt !== undefined) {
            await replace(rebuilt);
            continue;
          }
        }
        await replace({ ...c, error: message });
        continue;
      }
      window.dispatchEvent(new CustomEvent<WorkCommand>(WORK_COMMAND_SENT, { detail: sending }));
      await replace(null);
    }
    return false;
  });
}
export async function retryWork(user: string) {
  await locked(user, async () => {
    const rows = readWorkQueue(user);
    const awaitingReview = workAwaitingShiftReview(rows);
    saveQueue(
      user,
      rows
        // A start rejected for an unsigned toolbox talk never happened. It
        // must not be resent later with the time of the original tap, even if
        // the refusal arrived after an offline save and app reload.
        .filter((c) => !(c.action === "start" && c.error && isToolboxGateError(c.error)))
        .map((c) => awaitingReview.has(c.id) ? c : { ...c, error: undefined, retry: undefined }),
    );
  });
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

import { signInMark, stillSignedInAs, subscribeSignedIn, type SignInMark } from "../signedIn";
import { cloneJson } from "./model";
export interface PendingConfigurationIntent { kind: string; payload: { commandId: string } }
export interface PendingConfigurationRequest<T extends PendingConfigurationIntent = PendingConfigurationIntent> { readonly intent: T; readonly inFlight: boolean; readonly uncertain: boolean }
interface Attempt<T extends PendingConfigurationIntent> { scope: string; mark: SignInMark; intent: T; hadUnknown: boolean; token: object }
interface Stored extends PendingConfigurationRequest { token: object }
const records = new Map<string, Stored>();
const listeners = new Set<() => void>();
let boundary = signInMark();
function emit() { for (const listener of listeners) listener(); }
function sync(notify = true) {
  const now = signInMark();
  if (now.userId !== boundary.userId || now.generation !== boundary.generation) { boundary = now; records.clear(); if (notify) emit(); }
}
subscribeSignedIn(() => sync());
if (typeof window !== "undefined") window.addEventListener("beforeunload", event => {
  sync(false);
  if (records.size) { event.preventDefault(); event.returnValue = ""; }
});
function current(mark: SignInMark): boolean { sync(false); return Boolean(mark.userId && stillSignedInAs(mark, mark.userId)); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export function subscribePendingConfiguration(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** RAM only, no dispatcher or persistence. Navigation retains the exact
 * request; an auth-generation change erases prior private intents. */
export function pendingConfiguration<T extends PendingConfigurationIntent>(scope: string, mark: SignInMark): PendingConfigurationRequest<T> | null {
  if (!current(mark)) return null;
  const stored = records.get(scope);
  return stored ? stored as unknown as PendingConfigurationRequest<T> : null;
}
export function beginConfigurationAttempt<T extends PendingConfigurationIntent>(scope: string, mark: SignInMark, proposed: T): Attempt<T> {
  if (!current(mark)) throw Error("Sign-in changed");
  const previous = records.get(scope);
  if (previous?.inFlight || (previous && previous.intent !== proposed)) throw Error("Resolve the original request first");
  const intent = (previous?.intent ?? freeze(cloneJson(proposed))) as T;
  const token = {};
  records.set(scope, { intent, inFlight: true, uncertain: true, token }); emit();
  return { scope, mark, intent, hadUnknown: previous?.uncertain ?? false, token };
}
/** Refusal proves only this transaction rolled back. After an earlier unknown
 * attempt, only a valid receipt resolves the command, even after revocation. */
export function finishConfigurationAttempt(attempt: Attempt<PendingConfigurationIntent>, outcome: "receipt" | "refused" | "unknown") {
  if (!current(attempt.mark)) return;
  const stored = records.get(attempt.scope);
  if (!stored || stored.token !== attempt.token) return;
  if (outcome === "receipt" || (outcome === "refused" && !attempt.hadUnknown)) records.delete(attempt.scope);
  else records.set(attempt.scope, { ...stored, inFlight: false, uncertain: true });
  emit();
}

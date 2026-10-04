// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
let userId: string | null = "account-a", generation = 0;
const authListeners = new Set<() => void>();
vi.mock("../signedIn", () => ({ signInMark: () => ({ userId, generation }),
  stillSignedInAs: (mark: { userId: string | null; generation: number }, who: string) => mark.userId === who && userId === who && mark.generation === generation,
  subscribeSignedIn: (listener: () => void) => { authListeners.add(listener); return () => authListeners.delete(listener); },
}));
const pending = await import("./pending");
const mark = () => ({ userId, generation });
const intent = () => ({ kind: "activityDraft", payload: { commandId: "original-command", labelEn: "Private draft", typedFields: [] } });
beforeEach(() => { generation++; userId = "account-a"; for (const listener of authListeners) listener(); });
describe("private configuration request memory", () => {
  it("keeps uncertainty sticky across a later refused retry and resolves only with a receipt", () => {
    const first = pending.beginConfigurationAttempt("company", mark(), intent());
    pending.finishConfigurationAttempt(first, "unknown");
    const original = pending.pendingConfiguration("company", mark())!;
    const second = pending.beginConfigurationAttempt("company", mark(), original.intent);
    pending.finishConfigurationAttempt(second, "refused");
    expect(pending.pendingConfiguration("company", mark())?.intent).toBe(original.intent);
    expect(() => pending.beginConfigurationAttempt("company", mark(), intent())).toThrow("original request");
    const third = pending.beginConfigurationAttempt("company", mark(), original.intent); pending.finishConfigurationAttempt(third, "receipt");
    expect(pending.pendingConfiguration("company", mark())).toBeNull();
  });
  it("clears an initial confirmed refusal and blocks duplicate concurrent attempts", () => {
    const first = pending.beginConfigurationAttempt("company", mark(), intent());
    expect(() => pending.beginConfigurationAttempt("company", mark(), first.intent)).toThrow();
    pending.finishConfigurationAttempt(first, "refused"); expect(pending.pendingConfiguration("company", mark())).toBeNull();
  });
  it("clones immutable intent and isolates scopes across ordinary panel lifetimes", () => {
    const input = intent(); const first = pending.beginConfigurationAttempt("job:a", mark(), input);
    input.payload.labelEn = "Changed after send";
    expect(first.intent.payload.labelEn).toBe("Private draft"); expect(Object.isFrozen(first.intent.payload)).toBe(true);
    pending.finishConfigurationAttempt(first, "unknown");
    expect(pending.pendingConfiguration("job:b", mark())).toBeNull();
    expect(pending.pendingConfiguration("job:a", mark())?.intent).toBe(first.intent);
  });
  it("erases private intent on sign-out/ABA and ignores late settlement", () => {
    const oldMark = mark(), first = pending.beginConfigurationAttempt("company", oldMark, intent());
    userId = null; generation++; for (const listener of authListeners) listener();
    userId = "account-a"; generation++; for (const listener of authListeners) listener();
    pending.finishConfigurationAttempt(first, "receipt");
    expect(pending.pendingConfiguration("company", mark())).toBeNull(); expect(pending.pendingConfiguration("company", oldMark)).toBeNull();
    expect(() => pending.beginConfigurationAttempt("company", oldMark, intent())).toThrow("Sign-in changed");
  });
  it("requests browser exit confirmation only while a real command remains unresolved", () => {
    const first = pending.beginConfigurationAttempt("company", mark(), intent());
    const before = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(before); expect(before.defaultPrevented).toBe(true);
    pending.finishConfigurationAttempt(first, "receipt");
    const after = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(after); expect(after.defaultPrevented).toBe(false);
  });
});

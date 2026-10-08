import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installNativePhotoOutboxRecorder, readNativePhotoOutboxRecorder } from "../../../e2e/support/nativePhotoOutboxRecorder";

class Target extends EventTarget {
  error: unknown = null;
  onerror: ((event: Event) => void) | null = null;
  listenerCalls: string[] = [];
  listenerFailure = false;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
    this.listenerCalls.push(type);
    if (this.listenerFailure) throw new Error("fixture listener refusal");
    super.addEventListener(type, listener);
  }
  emit(type: string) {
    const event = new Event(type, { cancelable: true });
    this.dispatchEvent(event);
    if (type === "error") this.onerror?.(event);
    return event;
  }
}
class Transaction extends Target { db = { name: "wops-write-outbox" }; }
class Store {
  name = "entries";
  transaction = new Transaction();
  request = new Target();
  calls: { receiver: Store; method: string; args: unknown[] }[] = [];
  throws: unknown = undefined;
  invoke(method: string, args: unknown[]) {
    this.calls.push({ receiver: this, method, args });
    if (this.throws !== undefined) throw this.throws;
    return this.request;
  }
  get(...args: unknown[]) { return this.invoke("get", args); }
  put(...args: unknown[]) { return this.invoke("put", args); }
  delete(...args: unknown[]) { return this.invoke("delete", args); }
  getAll(...args: unknown[]) { return this.invoke("getAll", args); }
}
const originals = Object.getOwnPropertyDescriptors(Store.prototype);

beforeEach(() => {
  Object.defineProperties(Store.prototype, originals);
  vi.stubGlobal("IDBObjectStore", Store);
  installNativePhotoOutboxRecorder();
});
afterEach(() => {
  Object.defineProperties(Store.prototype, originals);
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "__forgePhotoOutboxRecorder");
});

describe("fixture native photo recorder transparent forwarding", () => {
  it("forwards each method synchronously once, with identical receiver/arguments/request", () => {
    const store = new Store();
    const value = { privatePayload: "payload must not be recorded" };
    const key = { privateKey: "key must not be recorded" };
    for (const method of ["get", "put", "delete", "getAll"] as const) {
      const result = store[method](value, key);
      expect(result).toBe(store.request);
      expect(store.calls.at(-1)).toEqual({ receiver: store, method, args: [value, key] });
      expect(store.calls.at(-1)!.args[0]).toBe(value);
      expect(store.calls.at(-1)!.args[1]).toBe(key);
    }
    expect(store.calls).toHaveLength(4);
    expect(JSON.stringify(readNativePhotoOutboxRecorder())).not.toMatch(/privatePayload|privateKey|payload must|key must/);
  });

  it("rethrows the identical native synchronous exception after one call", () => {
    const store = new Store();
    const original = { name: "DataCloneError", message: "do not disclose" };
    store.throws = original;
    let caught: unknown;
    try { store.put({ blob: "private" }); } catch (error) { caught = error; }
    expect(caught).toBe(original);
    expect(store.calls).toHaveLength(1);
    expect(readNativePhotoOutboxRecorder().events).toEqual([
      { sequence: 1, operation: "entries.put", stage: "throw", errorName: "DataCloneError" },
    ]);
  });

  it("preserves property handlers and error default propagation", () => {
    const store = new Store();
    const handler = vi.fn();
    store.request.onerror = handler;
    store.put("private");
    store.request.error = { name: "UnknownError" };
    const event = store.request.emit("error");
    expect(store.request.onerror).toBe(handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("observes distinct request error, null-detail transaction error, abort and complete", () => {
    const store = new Store();
    store.put("private");
    store.request.error = { name: "QuotaExceededError" };
    store.request.emit("error");
    store.transaction.emit("error");
    store.transaction.error = { name: "AbortError" };
    store.transaction.emit("abort");
    store.transaction.emit("complete");
    expect(readNativePhotoOutboxRecorder().events.slice(1)).toEqual([
      { sequence: 2, operation: "entries.put", stage: "error", errorName: "QuotaExceededError" },
      { sequence: 3, operation: "transaction", stage: "error", errorName: "missing" },
      { sequence: 4, operation: "transaction", stage: "abort", errorName: "AbortError" },
      { sequence: 5, operation: "transaction", stage: "complete", errorName: "missing" },
    ]);
    expect(store.calls).toHaveLength(1);
  });

  it("registers transaction listeners once, including across its two stores", () => {
    const entries = new Store();
    const metadata = new Store();
    metadata.name = "metadata";
    metadata.transaction = entries.transaction;
    entries.get("private");
    metadata.delete("private");
    entries.getAll();
    expect(entries.transaction.listenerCalls).toEqual(["complete", "abort", "error"]);
    expect(readNativePhotoOutboxRecorder().events.map((e) => e.operation)).toEqual([
      "entries.get", "metadata.delete", "entries.getAll",
    ]);
  });

  it("does not observe another database or another store", () => {
    const otherDatabase = new Store();
    otherDatabase.transaction.db.name = "other-private-database";
    const otherStore = new Store();
    otherStore.name = "other-private-store";
    expect(otherDatabase.get("private")).toBe(otherDatabase.request);
    expect(otherStore.put("private")).toBe(otherStore.request);
    expect(readNativePhotoOutboxRecorder().events).toEqual([]);
    expect(otherDatabase.request.listenerCalls).toEqual([]);
    expect(otherStore.request.listenerCalls).toEqual([]);
  });

  it("swallows identity and listener failures without changing returns or original throws", () => {
    const store = new Store();
    Object.defineProperty(store, "transaction", { get() { throw new Error("private identity"); } });
    expect(store.get("private")).toBe(store.request);
    const original = { name: "UnknownError" };
    store.throws = original;
    let caught: unknown;
    try { store.put("private"); } catch (error) { caught = error; }
    expect(caught).toBe(original);
    const refused = new Store();
    refused.request.listenerFailure = true;
    refused.transaction.listenerFailure = true;
    expect(refused.put("private")).toBe(refused.request);
    expect(readNativePhotoOutboxRecorder().events.map((e) => e.stage)).toContain("identity-unavailable");
    expect(readNativePhotoOutboxRecorder().events.map((e) => e.stage)).toContain("request-listener-unavailable");
  });

  it("redacts arbitrary/hostile names and never accesses messages or stringifiers", () => {
    const store = new Store();
    store.getAll();
    let forbiddenReads = 0;
    const error = {
      name: "private-name-must-not-escape",
      get message() { forbiddenReads++; throw new Error("private message"); },
      toString() { forbiddenReads++; throw new Error("private stringifier"); },
    };
    store.request.error = error;
    store.request.emit("error");
    store.request.error = Object.defineProperty({}, "name", { get() { throw new Error("private name"); } });
    store.request.emit("error");
    Object.defineProperty(store.request, "error", { get() { throw new Error("private getter"); } });
    store.request.emit("error");
    expect(readNativePhotoOutboxRecorder().events.slice(1).map((e) => e.errorName)).toEqual(["other", "unreadable", "unreadable"]);
    expect(forbiddenReads).toBe(0);
    expect(JSON.stringify(readNativePhotoOutboxRecorder())).not.toContain("private");
  });

  it("keeps a primitive isolated snapshot and first256 events with explicit loss", () => {
    const store = new Store();
    for (let i = 0; i < 260; i++) { store.request = new Target(); store.get("private"); }
    const snapshot = readNativePhotoOutboxRecorder();
    expect(snapshot.installed).toBe(true);
    expect(snapshot.events).toHaveLength(256);
    expect(snapshot.dropped).toBe(4);
    expect(snapshot.events[0].sequence).toBe(1);
    expect(snapshot.events.at(-1)!.sequence).toBe(256);
    snapshot.events[0].operation = "tampered";
    snapshot.events.length = 0;
    expect(readNativePhotoOutboxRecorder().events).toHaveLength(256);
    expect(readNativePhotoOutboxRecorder().events[0].operation).toBe("entries.get");
    expect(store.calls).toHaveLength(260);
  });
});

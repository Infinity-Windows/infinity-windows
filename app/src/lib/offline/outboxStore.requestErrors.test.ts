// IndexedDbOutboxStore.put failure diagnostics (photo queue put failure,
// CI 37407023694: "Photo queue storage put failed (no browser error detail)").
//
// Driven through the public put() over a minimal fake indexedDB that fires
// events in the browser's order: a failed request's error event first, at the
// request (where tx.error is still null), then the transaction's error, then
// its abort. This fake is a control for the diagnostic contract and for what
// put() must NOT change — it is not a real browser, and it proves nothing
// about native atomic rollback. Real WebKit on Linux CI is still the check.
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEntry, serializeEntry } from "./outbox-core";
import { IndexedDbOutboxStore } from "./outboxStore";

type Outcome = { error: unknown } | { result?: unknown };

interface Plan {
  /** Per request label ("entries.get", "entries.put", "metadata.delete", "metadata.put"); default success. */
  outcomes?: Record<string, Outcome>;
  /** A request label whose call throws synchronously, before any request exists. */
  throwOn?: string;
  /** What tx.error reads while a request's error bubbles to the transaction. */
  txErrorAtError?: unknown;
  /** What tx.error reads once the transaction has aborted. */
  txErrorAtAbort?: unknown;
  /** The error delivered to requests still pending when the transaction aborts. */
  abortRequestError?: unknown;
  /** Keep the transaction open until the test fires its completion. */
  holdComplete?: boolean;
  /** Fail at commit with only a transaction abort, no request error. */
  abortAtComplete?: unknown;
}

interface World {
  created: string[];
  calls: { op: string; argument: unknown }[];
  closes: number;
  /** tx.abort() calls made by the code under test. */
  aborts: number;
  errorEvents: { op: string; defaultPrevented: boolean; laterListenerRan: boolean }[];
  completeTx: (() => void) | null;
}

const later = (fn: () => void) => { setTimeout(fn, 0); };

class FakeRequest extends EventTarget {
  result: unknown = undefined;
  error: unknown = null;
  readyState: "pending" | "done" = "pending";
  onsuccess: ((event: Event) => void) | null = null;
  readonly op: string;
  constructor(op: string) {
    super();
    this.op = op;
  }
}

class FakeTransaction extends EventTarget {
  error: unknown = null;
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  private pending = new Set<FakeRequest>();
  private finished = false;
  private readonly plan: Plan;
  private readonly world: World;

  constructor(plan: Plan, world: World) {
    super();
    this.plan = plan;
    this.world = world;
  }

  objectStore(name: string) {
    const prefix = name === "entries" ? "entries" : "metadata";
    return {
      get: (argument: unknown) => this.request(`${prefix}.get`, argument),
      put: (argument: unknown) => this.request(`${prefix}.put`, argument),
      delete: (argument: unknown) => this.request(`${prefix}.delete`, argument),
    };
  }

  abort() {
    this.world.aborts++;
    if (this.finished) throw new DOMException("The transaction has finished.", "InvalidStateError");
    later(() => this.abortNow());
  }

  private request(op: string, argument: unknown): FakeRequest {
    this.world.calls.push({ op, argument });
    if (this.plan.throwOn === op) throw new DOMException("Synthetic clone refusal", "DataCloneError");
    const request = new FakeRequest(op);
    this.world.created.push(op);
    this.pending.add(request);
    later(() => this.settle(request));
    return request;
  }

  private settle(request: FakeRequest) {
    if (this.finished || !this.pending.has(request)) return;
    this.pending.delete(request);
    request.readyState = "done";
    const outcome = this.plan.outcomes?.[request.op] ?? {};
    if ("error" in outcome) {
      this.fireRequestError(request, outcome.error, this.plan.txErrorAtError ?? null);
      if (!this.finished) this.abortNow();
      return;
    }
    request.result = outcome.result;
    request.onsuccess?.(new Event("success"));
    if (this.pending.size === 0) later(() => this.complete());
  }

  /** The request's own listeners first, then (unless cancelled) the transaction. */
  private fireRequestError(request: FakeRequest, reason: unknown, txError: unknown) {
    request.error = reason;
    let laterListenerRan = false;
    request.addEventListener("error", () => { laterListenerRan = true; });
    const event = new Event("error", { bubbles: true, cancelable: true });
    request.dispatchEvent(event);
    this.world.errorEvents.push({ op: request.op, defaultPrevented: event.defaultPrevented, laterListenerRan });
    if (event.defaultPrevented) return;
    this.error = txError;
    this.onerror?.(event);
  }

  private abortNow() {
    if (this.finished) return;
    this.finished = true;
    for (const request of [...this.pending]) {
      this.pending.delete(request);
      request.readyState = "done";
      this.fireRequestError(request, this.plan.abortRequestError ?? null, this.error);
    }
    if ("txErrorAtAbort" in this.plan) this.error = this.plan.txErrorAtAbort;
    const event = new Event("abort");
    this.dispatchEvent(event);
    this.onabort?.(event);
  }

  private complete() {
    if (this.finished || this.pending.size > 0) return;
    const fire = () => {
      if (this.finished) return;
      if ("abortAtComplete" in this.plan) {
        this.error = this.plan.abortAtComplete;
        this.abortNow();
        return;
      }
      this.finished = true;
      this.oncomplete?.(new Event("complete"));
    };
    if (this.plan.holdComplete) this.world.completeTx = fire;
    else fire();
  }
}

function installFakeIndexedDb(plan: Plan): World {
  const world: World = { created: [], calls: [], closes: 0, aborts: 0, errorEvents: [], completeTx: null };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => new FakeTransaction(plan, world),
    close: () => { world.closes++; },
    onversionchange: null as unknown,
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request = { result: db, error: null, onsuccess: null as null | (() => void), onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => request.onsuccess?.());
      return request;
    },
  });
  return world;
}

const entry = makeEntry({ op: "photo_upload", payload: { kind: "photo" }, hasBlob: true }, "outbox-entry-1", 1);
const blob = new Blob(["photo bytes"], { type: "image/png" });
const existingRow = { result: { id: "outbox-entry-1", meta: "{}", blob } };

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("put resolved, but this case must fail");
}

/** Every error event reached its later listeners, uncancelled, and the store never aborted it itself. */
function expectNativeEventUntouched(world: World) {
  expect(world.errorEvents.length).toBeGreaterThan(0);
  expect(world.errorEvents.every((e) => !e.defaultPrevented && e.laterListenerRan)).toBe(true);
  expect(world.aborts).toBe(0);
  expect(world.closes).toBe(1);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IndexedDbOutboxStore.put failure diagnostics", () => {
  it.each([
    ["entries.get", { "entries.get": { error: new DOMException("Synthetic read refusal", "UnknownError") } }, null, "UnknownError: Synthetic read refusal", ["entries.get"]],
    ["entries.put", { "entries.put": { error: new DOMException("Synthetic key clash", "ConstraintError") } }, blob, "ConstraintError: Synthetic key clash", ["entries.get", "entries.put", "metadata.delete"]],
    ["metadata.delete", { "metadata.delete": { error: new DOMException("Synthetic delete refusal", "UnknownError") } }, blob, "UnknownError: Synthetic delete refusal", ["entries.get", "entries.put", "metadata.delete"]],
    ["metadata.put", { "entries.get": existingRow, "metadata.put": { error: new DOMException("Synthetic quota", "QuotaExceededError") } }, null, "QuotaExceededError: Synthetic quota", ["entries.get", "metadata.put"]],
  ] as const)("names the first failed %s request and its cause when the transaction has none", async (operation, outcomes, putBlob, detail, created) => {
    const world = installFakeIndexedDb({ outcomes: { ...outcomes } });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, putBlob));
    expect(error.message).toBe(`Photo queue storage put (${operation}) failed (${detail})`);
    expect(world.created).toEqual(created);
    expectNativeEventUntouched(world);
  });

  it("keeps the first request's cause over a later request's and the abort's", async () => {
    const world = installFakeIndexedDb({
      outcomes: { "entries.put": { error: new DOMException("first cause", "ConstraintError") } },
      abortRequestError: new DOMException("later request", "AbortError"),
      txErrorAtError: new DOMException("transaction cause already available", "QuotaExceededError"),
      txErrorAtAbort: new DOMException("abort cause", "QuotaExceededError"),
    });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
    expect(error.message).toBe("Photo queue storage put (entries.put) failed (ConstraintError: first cause)");
    expect(world.errorEvents.map((e) => e.op)).toEqual(["entries.put", "metadata.delete"]);
    expectNativeEventUntouched(world);
  });

  it("never hands a detail-less first failure to a later request; a usable transaction error is labelled as the transaction", async () => {
    const world = installFakeIndexedDb({
      outcomes: { "entries.put": { error: null } },
      txErrorAtError: { name: "QuotaExceededError", message: "transaction said" },
      abortRequestError: new DOMException("later request", "AbortError"),
    });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
    expect(error.message).toBe("Photo queue storage put transaction failed (QuotaExceededError: transaction said)");
    expect(error.message).not.toContain("entries.put");
    expect(error.message).not.toContain("metadata.delete");
    expect(error.message).not.toContain("later request");
    expectNativeEventUntouched(world);
  });

  it("reports the first operation with no detail when neither it nor the transaction has one", async () => {
    const world = installFakeIndexedDb({
      outcomes: { "entries.put": { error: null } },
      abortRequestError: new DOMException("later request", "AbortError"),
      txErrorAtAbort: new DOMException("abort cause", "QuotaExceededError"),
    });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
    expect(error.message).toBe("Photo queue storage put (entries.put) failed (no browser error detail)");
    expectNativeEventUntouched(world);
  });

  it("reads causes that are not instanceof Error, primitives, and getters that throw, without losing the failure", async () => {
    const hostile = new Error("never read");
    Object.defineProperty(hostile, "message", { get() { throw new Error("message getter"); } });
    Object.defineProperty(hostile, "name", { get() { throw new Error("name getter"); } });
    const nameOnly = { name: "WeirdError" };
    Object.defineProperty(nameOnly, "message", { get() { throw new Error("message getter"); } });
    const cases: [unknown, string][] = [
      [{ name: "QuotaExceededError", message: "cross-realm quota" }, "QuotaExceededError: cross-realm quota"],
      [nameOnly, "WeirdError"],
      ["quota-string", "quota-string"],
      [hostile, "no browser error detail"],
    ];
    for (const [reason, detail] of cases) {
      const world = installFakeIndexedDb({ outcomes: { "entries.put": { error: reason } } });
      const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
      expect(error.message).toBe(`Photo queue storage put (entries.put) failed (${detail})`);
      expectNativeEventUntouched(world);
      vi.unstubAllGlobals();
    }
  });

  it("keeps a synchronous scheduling throw unlabelled, rejects with its cause and aborts", async () => {
    const world = installFakeIndexedDb({ throwOn: "entries.put" });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
    expect(error.message).toBe("Photo queue storage put failed (DataCloneError: Synthetic clone refusal)");
    expect(world.created).toEqual(["entries.get"]);
    expect(world.aborts).toBe(1);
    expect(world.closes).toBe(1);
  });

  it("does not stringify opaque objects or misattribute their private content to the first operation", async () => {
    const sentinel = "private-row-blob-metadata-sentinel";
    const stringify = vi.fn(() => sentinel);
    const opaque = { toString: stringify };
    Object.defineProperty(opaque, "name", { get() { throw new Error("name getter"); } });
    Object.defineProperty(opaque, "message", { get() { throw new Error("message getter"); } });
    const transactionCause = new DOMException("transaction said", "QuotaExceededError");
    const world = installFakeIndexedDb({
      outcomes: { "entries.put": { error: opaque } },
      txErrorAtError: transactionCause,
      abortRequestError: new DOMException("later request", "AbortError"),
    });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
    expect(error.message).toBe("Photo queue storage put transaction failed (QuotaExceededError: transaction said)");
    expect(error.cause).toBe(transactionCause);
    expect(error.message).not.toContain(sentinel);
    expect(stringify).not.toHaveBeenCalled();
    expectNativeEventUntouched(world);
  });

  it("retains an opaque first cause without stringifying it when no transaction detail exists", async () => {
    const stringify = vi.fn(() => "private-sentinel");
    const opaque = { toString: stringify };
    const world = installFakeIndexedDb({ outcomes: { "entries.put": { error: opaque } } });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
    expect(error.message).toBe("Photo queue storage put (entries.put) failed (no browser error detail)");
    expect(error.cause).toBe(opaque);
    expect(stringify).not.toHaveBeenCalled();
    expectNativeEventUntouched(world);
  });

  it("reports a transaction-only commit abort without adding an explicit abort", async () => {
    const cause = new DOMException("commit refused", "QuotaExceededError");
    const world = installFakeIndexedDb({ abortAtComplete: cause });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
    expect(error.message).toBe("Photo queue storage put aborted failed (QuotaExceededError: commit refused)");
    expect(error.cause).toBe(cause);
    expect(world.errorEvents).toEqual([]);
    expect(world.aborts).toBe(0);
    expect(world.closes).toBe(1);
  });

  it.each(["insertIfAbsent", "swap"] as const)("keeps the unwatched %s phase while falling back to its failed request", async (operation) => {
    const cause = new DOMException("read refused", "UnknownError");
    const world = installFakeIndexedDb({ outcomes: { "entries.get": { error: cause } } });
    const store = new IndexedDbOutboxStore();
    const promise = operation === "insertIfAbsent" ? store.insertIfAbsent(entry, blob) : store.swap(entry.id, null, entry);
    const error = await failureOf(promise);
    expect(error.message).toBe(`Photo queue storage ${operation} failed (UnknownError: read refused)`);
    expect(error.cause).toBe(cause);
    expect(world.created).toEqual(["entries.get", "metadata.get"]);
    expectNativeEventUntouched(world);
  });

  it("preserves an already wrapped failure without changing its phase or identity", async () => {
    const wrapped = new Error("Photo queue storage earlier failed (original)");
    const world = installFakeIndexedDb({ outcomes: { "entries.put": { error: wrapped } } });
    const error = await failureOf(new IndexedDbOutboxStore().put(entry, blob));
    expect(error).toBe(wrapped);
    expectNativeEventUntouched(world);
  });

  it("updates only metadata when an existing photo has no replacement blob", async () => {
    const world = installFakeIndexedDb({ outcomes: { "entries.get": existingRow } });
    await new IndexedDbOutboxStore().put(entry, null);
    expect(world.calls).toEqual([
      { op: "entries.get", argument: entry.id },
      { op: "metadata.put", argument: { id: entry.id, meta: serializeEntry(entry) } },
    ]);
    expect(world.closes).toBe(1);
    expect(world.aborts).toBe(0);
  });

  it("stays pending until the transaction completes, then resolves", async () => {
    const world = installFakeIndexedDb({ holdComplete: true });
    let settled = false;
    const put = new IndexedDbOutboxStore().put(entry, blob).then(() => { settled = true; });
    await vi.waitFor(() => expect(world.completeTx).not.toBeNull());
    expect(world.created).toEqual(["entries.get", "entries.put", "metadata.delete"]);
    expect(settled).toBe(false);
    expect(world.closes).toBe(0);
    expect(world.calls).toEqual([
      { op: "entries.get", argument: entry.id },
      { op: "entries.put", argument: { id: entry.id, meta: serializeEntry(entry), blob } },
      { op: "metadata.delete", argument: entry.id },
    ]);
    world.completeTx!();
    await put;
    expect(settled).toBe(true);
    expect(world.errorEvents).toEqual([]);
    expect(world.aborts).toBe(0);
    expect(world.closes).toBe(1);
  });
});

// Fixture-only, in-memory observation of the existing photo outbox requests.
// No results, arguments, keys, messages, rows, blobs or identity data are read.
// A fresh document starts a fresh buffer. This is useful for a failure before
// navigation; it is not a cross-reload history or proof of observer neutrality.
export interface NativePhotoOutboxEvent {
  sequence: number;
  operation: string;
  stage: string;
  errorName: string;
}

export interface NativePhotoOutboxSnapshot {
  version: 1;
  installed: boolean;
  dropped: number;
  events: NativePhotoOutboxEvent[];
}

/** Standalone function: Playwright serializes it into each new document. */
export function installNativePhotoOutboxRecorder(): void {
  const root = globalThis as typeof globalThis & {
    __forgePhotoOutboxRecorder?: { snapshot: () => NativePhotoOutboxSnapshot };
  };
  const events: NativePhotoOutboxEvent[] = [];
  let sequence = 0;
  let dropped = 0;
  let installed = false;
  const allowedNames = new Set([
    "AbortError", "ConstraintError", "DataCloneError", "DataError",
    "InvalidAccessError", "InvalidStateError", "NotFoundError",
    "QuotaExceededError", "ReadOnlyError", "SecurityError",
    "TransactionInactiveError", "UnknownError", "VersionError",
    "TypeError", "RangeError", "Error",
  ]);
  const record = (operation: string, stage: string, errorName = "missing") => {
    try {
      sequence++;
      if (events.length === 256) { dropped++; return; }
      events.push({ sequence, operation, stage, errorName });
    } catch { /* Recorder failures must never escape into the app. */ }
  };
  const nameOf = (error: unknown): string => {
    if (error == null) return "missing";
    try {
      const name = (error as { name?: unknown }).name;
      return typeof name === "string" && allowedNames.has(name) ? name : "other";
    } catch { return "unreadable"; }
  };
  const errorOf = (source: { readonly error: unknown }): string => {
    try { return nameOf(source.error); } catch { return "unreadable"; }
  };
  const transactions = new WeakSet<IDBTransaction>();
  const identify = (store: IDBObjectStore, method: string) => {
    try {
      const transaction = store.transaction;
      if (transaction.db.name !== "wops-write-outbox") return null;
      const storeName = store.name;
      if (storeName !== "entries" && storeName !== "metadata") return null;
      return { transaction, operation: `${storeName}.${method}` };
    } catch {
      record("recorder", "identity-unavailable", "unreadable");
      return null;
    }
  };
  const watchTransaction = (transaction: IDBTransaction) => {
    try {
      if (transactions.has(transaction)) return;
      transactions.add(transaction);
      transaction.addEventListener("complete", () => record("transaction", "complete"));
      transaction.addEventListener("abort", () => record("transaction", "abort", errorOf(transaction)));
      // A request error may bubble here before transaction.error is populated.
      // These are separate observations, never a claim about the root cause.
      transaction.addEventListener("error", () => record("transaction", "error", errorOf(transaction)));
    } catch { record("recorder", "transaction-listener-unavailable", "unreadable"); }
  };
  try {
    Object.defineProperty(root, "__forgePhotoOutboxRecorder", {
      configurable: true,
      value: {
        snapshot: () => ({
          version: 1, installed, dropped, events: events.map((event) => ({ ...event })),
        }),
      },
    });
    for (const method of ["get", "put", "delete", "getAll"] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, method);
      const original = descriptor?.value;
      if (!descriptor || typeof original !== "function") {
        record("recorder", "method-unavailable", "missing");
        continue;
      }
      Object.defineProperty(IDBObjectStore.prototype, method, {
        ...descriptor,
        value: function (this: IDBObjectStore, ...args: unknown[]) {
          let request: IDBRequest;
          try {
            // Native invocation happens first, once, with its original receiver
            // and arguments. Identity inspection cannot change brand checks.
            request = Reflect.apply(original, this, args) as IDBRequest;
          } catch (error) {
            const target = identify(this, method);
            if (target) record(target.operation, "throw", nameOf(error));
            throw error;
          }
          const target = identify(this, method);
          if (target) {
            record(target.operation, "returned");
            watchTransaction(target.transaction);
            try {
              request.addEventListener("success", () => record(target.operation, "success"));
              request.addEventListener("error", () => record(target.operation, "error", errorOf(request)));
            } catch { record("recorder", "request-listener-unavailable", "unreadable"); }
          }
          return request;
        },
      });
    }
    installed = true;
  } catch { record("recorder", "installation-unavailable", "unreadable"); }
}

/** Read-only snapshot; neither this nor installation issues a database request. */
export function readNativePhotoOutboxRecorder(): NativePhotoOutboxSnapshot {
  const root = globalThis as typeof globalThis & {
    __forgePhotoOutboxRecorder?: { snapshot: () => NativePhotoOutboxSnapshot };
  };
  return root.__forgePhotoOutboxRecorder?.snapshot() ?? {
    version: 1, installed: false, dropped: 0, events: [],
  };
}

import { versionUrl } from "../pwa/buildInfo";

export type PhoneCheckStatus = "pass" | "fail" | "unsupported";
export type PhoneCheckKind = "storage" | "connection" | "microphone" | "camera";
export type PhoneCheckReason = "unavailable" | "saved" | "write_failed" | "offline" | "reachable" | "server_error" |
  "timeout" | "unreachable" | "permission" | "missing" | "busy" | "microphone_unsupported" |
  "microphone_busy" | "failed" | "confirmed" | "not_working";
export type PhoneCheckResult = { status: PhoneCheckStatus; reason: PhoneCheckReason; at: number; durationMs?: number };

/** Probe a dedicated key, then remove it. No job data or existing outbox is touched. */
export async function checkPhoneStorage(): Promise<PhoneCheckResult> {
  const at = Date.now();
  if (typeof indexedDB === "undefined") return { status: "unsupported", reason: "unavailable", at };
  let db: IDBDatabase | undefined;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("forge-phone-check", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checks");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("blocked"));
    });
    const key = `check-${at}-${Math.random()}`;
    const value = `ok-${at}`;
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction("checks", "readwrite");
      const store = transaction.objectStore("checks");
      store.put(value, key);
      const read = store.get(key);
      read.onsuccess = () => {
        if (read.result !== value) transaction.abort();
        else store.delete(key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return { status: "pass", reason: "saved", at, durationMs: Date.now() - at };
  } catch {
    return { status: "fail", reason: "write_failed", at, durationMs: Date.now() - at };
  } finally {
    db?.close();
  }
}

/** Checks that the app host answers. Database sync remains a separate Diagnostics fact. */
export async function checkAppConnection(): Promise<PhoneCheckResult> {
  const at = Date.now();
  if (!navigator.onLine) return { status: "fail", reason: "offline", at };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    // The file is not precached, and the query also bypasses the Pages CDN cache.
    const response = await fetch(`${versionUrl()}?phoneCheck=${at}`, { cache: "no-store", credentials: "omit", signal: controller.signal });
    return { status: response.ok ? "pass" : "fail", reason: response.ok ? "reachable" : "server_error", at, durationMs: Date.now() - at };
  } catch {
    return { status: "fail", reason: controller.signal.aborted ? "timeout" : "unreachable", at, durationMs: Date.now() - at };
  } finally {
    clearTimeout(timeout);
  }
}

export function mediaFailure(error: unknown): PhoneCheckResult {
  const at = Date.now();
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError")
    return { status: "fail", reason: "permission", at };
  if (name === "NotFoundError" || name === "DevicesNotFoundError")
    return { status: "fail", reason: "missing", at };
  if (name === "NotReadableError" || name === "TrackStartError")
    return { status: "fail", reason: "busy", at };
  if (error instanceof Error && (error.message === "microphone_unsupported" || error.message === "microphone_busy"))
    return { status: error.message === "microphone_unsupported" ? "unsupported" : "fail", reason: error.message, at };
  return { status: "fail", reason: "failed", at };
}

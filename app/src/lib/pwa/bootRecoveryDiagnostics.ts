import { logOfflineEvent } from "../offline/telemetry";

const EMPTY_BOOT_KEY = "wops-empty-boot-diagnostic";
const UPDATE_RELOAD_KEY = "wops-update-reload-diagnostic";

type StorageReader = Pick<Storage, "getItem" | "removeItem">;

/** Carry a reload's cause into the next document, where Diagnostics can show it. */
export function reportPreviousBootRecovery(storage: StorageReader | null = safeSessionStorage()): void {
  if (!storage) return;
  for (const [key, scope] of [[UPDATE_RELOAD_KEY, "app-update"], [EMPTY_BOOT_KEY, "empty-boot"]] as const) {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
      if (raw) storage.removeItem(key);
    } catch {
      continue;
    }
    if (!raw) continue;
    try {
      const record: unknown = JSON.parse(raw);
      if (!record || typeof record !== "object") continue;
      const r = record as Record<string, unknown>;
      if (typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
      if (Date.now() - r.at > 5 * 60_000 || r.at - Date.now() > 60_000) continue;
      const detail = scope === "app-update"
        ? `Update reload: ${r.reason === "takeover-fallback" ? "takeover fallback" : "controller change"}`
        : `Recovered empty app shell; entry ${safeAsset(r.entry)}; recent assets ${Array.isArray(r.resources) ? r.resources.slice(-8).map(safeAsset).join(", ") : "unknown"}`;
      logOfflineEvent({ type: "reload", scope, message: detail }, r.at);
    } catch {
      // Corrupt diagnostics never block a crew member from opening Forge.
    }
  }
}

function safeSessionStorage(): StorageReader | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; }
  catch { return null; }
}

function safeAsset(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : "unknown";
}

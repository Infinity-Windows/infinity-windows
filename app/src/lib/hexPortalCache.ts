import type { PortalGuidance } from "./hexPortal";
import { signedInUserId, subscribeSignedIn } from "./signedIn";

/** A short, owner-only phone copy of guidance already returned by HexCore. */
const KEY = "iw.hex-portal.reviewed.v1";
export const GUIDANCE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_ROWS = 8;
const MAX_ITEM_CHARS = 12_000;

interface Row { projectId: string; questionHash: string; checkedAt: number; items: PortalGuidance[] }
interface Cache { ownerId: string; rows: Row[] }

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function readStore(): Cache | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Cache;
    return typeof value.ownerId === "string" && Array.isArray(value.rows) ? value : null;
  } catch { return null; }
}

function writeStore(value: Cache): void {
  try { storage()?.setItem(KEY, JSON.stringify(value)); } catch { /* the live answer remains available */ }
}

async function questionHash(projectId: string, question: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(`${projectId}\n${question.trim().toLocaleLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function validItem(item: PortalGuidance): boolean {
  return typeof item.id === "string" && /^[0-9a-f-]{36}$/.test(item.id) &&
    Number.isSafeInteger(item.revision) && item.revision > 0 &&
    [item.title, item.answer, item.applicability, item.evidence, item.reviewBy]
      .every((part) => typeof part === "string") && JSON.stringify(item).length <= MAX_ITEM_CHARS;
}

export function clearPortalGuidanceCache(): void {
  try { storage()?.removeItem(KEY); } catch { /* unavailable storage */ }
}

export async function forgetVerifiedGuidance(userId: string, projectId: string, question: string): Promise<void> {
  if (signedInUserId() !== userId) return;
  const hash = await questionHash(projectId, question);
  const cache = readStore();
  if (!hash || cache?.ownerId !== userId) return;
  writeStore({ ownerId: userId, rows: cache.rows.filter((row) => row.projectId !== projectId || row.questionHash !== hash) });
}

/** Store only an exact live response that passed both server access checks. */
export async function rememberVerifiedGuidance(userId: string, projectId: string, question: string, items: PortalGuidance[], now = Date.now()): Promise<void> {
  if (signedInUserId() !== userId || items.length < 1 || items.length > 3 || !items.every(validItem)) return;
  const hash = await questionHash(projectId, question);
  if (!hash || signedInUserId() !== userId) return;
  const prior = readStore();
  const rows = (prior?.ownerId === userId ? prior.rows : [])
    .filter((row) => row.projectId !== projectId || row.questionHash !== hash)
    .filter((row) => now - row.checkedAt < GUIDANCE_CACHE_MAX_AGE_MS)
    .slice(0, MAX_ROWS - 1);
  writeStore({ ownerId: userId, rows: [{ projectId, questionHash: hash, checkedAt: now, items }, ...rows] });
}

/** Only for offline display, never for an online fallback or an action gate. */
export async function readOfflineGuidance(userId: string, projectId: string, question: string, now = Date.now()): Promise<{ items: PortalGuidance[]; checkedAt: number } | null> {
  if (signedInUserId() !== userId || (typeof navigator !== "undefined" && navigator.onLine)) return null;
  const hash = await questionHash(projectId, question);
  if (!hash || signedInUserId() !== userId) return null;
  const cache = readStore();
  if (cache?.ownerId !== userId) return null;
  const row = cache.rows.find((r) => r.projectId === projectId && r.questionHash === hash);
  if (!row || !Number.isFinite(row.checkedAt) || now < row.checkedAt || now - row.checkedAt > GUIDANCE_CACHE_MAX_AGE_MS || !Array.isArray(row.items) || row.items.length < 1 || row.items.length > 3 || !row.items.every(validItem)) return null;
  return { items: row.items, checkedAt: row.checkedAt };
}

// A fresh connection requires a fresh HexCore check. Erasing is safer than
// trying to infer whether an unshared or withdrawn revision is still valid.
if (typeof window !== "undefined") {
  window.addEventListener("online", clearPortalGuidanceCache);
  if (navigator.onLine) clearPortalGuidanceCache();
}
let lastSignedIn = signedInUserId();
subscribeSignedIn(() => {
  const next = signedInUserId();
  if (!next || (lastSignedIn && next !== lastSignedIn) || (next && readStore()?.ownerId !== next)) clearPortalGuidanceCache();
  lastSignedIn = next;
});

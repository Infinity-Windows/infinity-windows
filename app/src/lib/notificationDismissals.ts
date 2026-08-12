// Per-person notification dismissals: see it once, clear it, never again —
// for THAT occurrence. Every feed row is keyed by its identity plus a
// content fingerprint, so clearing is permanent while a genuinely new event
// (new punches, another mention, a service badge that changed) mints a new
// key and comes back. Stored server-side so a cleared feed stays cleared on
// every device; falls back to localStorage until the table is migrated.

import { supabase } from "./supabase";
import { isMissingTable } from "./schemaErrors";

const LS_KEY = "notifDismissals.v1";

/** Tiny stable hash for fingerprinting id lists — not cryptographic. */
export function fingerprint(parts: (string | number)[]): string {
  const s = parts.join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function readLocal(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function writeLocal(keys: Set<string>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...keys].slice(-500)));
  } catch {
    // Storage full/blocked — dismissals just won't stick on this device.
  }
}

export async function listDismissedKeys(profileId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("notification_dismissals")
    .select("key")
    .eq("profile_id", profileId)
    .limit(2000);
  if (error) {
    if (isMissingTable(error, "notification_dismissals")) return readLocal();
    throw error;
  }
  return new Set((data ?? []).map((r) => (r as { key: string }).key));
}

export async function dismissKeys(profileId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const { error } = await supabase
    .from("notification_dismissals")
    .upsert(
      keys.map((key) => ({ profile_id: profileId, key })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  if (error) {
    if (isMissingTable(error, "notification_dismissals")) {
      const cur = readLocal();
      for (const k of keys) cur.add(k);
      writeLocal(cur);
      return;
    }
    throw error;
  }
}

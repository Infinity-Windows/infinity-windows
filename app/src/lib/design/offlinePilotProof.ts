// A short-lived copy of an owner pilot answer for a phone that reloads without
// signal. This only chooses a UI shell. Every protected read/write still goes
// through the signed-in session and the server's own permissions.

export const OFFLINE_PILOT_PROOF_KEY = "forge.redesign.owner-pilot.v1";
export const OFFLINE_PILOT_PROOF_MS = 12 * 60 * 60_000;
const CLOCK_SKEW_MS = 5 * 60_000;

export interface PilotSignIn {
  access_token: string;
  user: { id: string };
}

interface Proof {
  v: 1;
  userId: string;
  sessionId: string;
  choice: "new";
  issuedAt: number;
  expiresAt: number;
}

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Supabase's session_id JWT claim survives a refresh but changes on login. */
export function pilotSessionId(session: PilotSignIn | null): string | null {
  if (!session?.user?.id || typeof session.access_token !== "string") return null;
  try {
    const encoded = session.access_token.split(".")[1];
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as {
      sub?: unknown; session_id?: unknown;
    };
    const id = claims.session_id;
    return claims.sub === session.user.id && typeof id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? id : null;
  } catch { return null; }
}

export function forgetOfflinePilotProof(): void {
  try { storage()?.removeItem(OFFLINE_PILOT_PROOF_KEY); } catch { /* storage unavailable */ }
}

/** Only call after a fresh server yes AND the matching real owner profile. */
export function rememberOfflinePilotProof(session: PilotSignIn | null, now = Date.now()): boolean {
  const sessionId = pilotSessionId(session);
  const store = storage();
  if (!sessionId || !session || !store) return false;
  const proof: Proof = {
    v: 1, userId: session.user.id, sessionId, choice: "new",
    issuedAt: now, expiresAt: now + OFFLINE_PILOT_PROOF_MS,
  };
  try { store.setItem(OFFLINE_PILOT_PROOF_KEY, JSON.stringify(proof)); return true; }
  catch { return false; }
}

/** A different account or login, expiry, or corrupt proof never opens New. */
export function readOfflinePilotProof(session: PilotSignIn | null, now = Date.now()): boolean {
  const sessionId = pilotSessionId(session);
  if (!sessionId || !session) return false;
  try {
    const raw = storage()?.getItem(OFFLINE_PILOT_PROOF_KEY);
    if (!raw) return false;
    const p = JSON.parse(raw) as Partial<Proof> | null;
    return !!p && p.v === 1 && p.choice === "new"
      && p.userId === session.user.id && p.sessionId === sessionId
      && typeof p.issuedAt === "number" && Number.isFinite(p.issuedAt)
      && typeof p.expiresAt === "number" && Number.isFinite(p.expiresAt)
      && p.expiresAt - p.issuedAt === OFFLINE_PILOT_PROOF_MS
      && now >= p.issuedAt - CLOCK_SKEW_MS && now < p.expiresAt;
  } catch { return false; }
}

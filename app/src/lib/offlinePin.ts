// The shift-long offline unlock (the owner's decision, 2026-09-24).
//
// A PIN is checked by the server — check_my_pin, bcrypt; the PIN and its hash
// never leave the database (docs/profiles-security-2026-07-29.md). On a site
// with no signal that left a PIN account locked out of its own clock. The
// owner's call: once the server has said yes on THIS phone, the phone keeps a
// slow, salted fingerprint of that PIN for twelve hours, and when the server
// cannot be reached it checks the same four digits against it.
//
// What is kept, for one signed-in person, in localStorage under OFFLINE_PIN_KEY:
// a random 16-byte salt, PBKDF2-HMAC-SHA-256 of the PIN (over that salt and the
// person's id), the round count, when it was made, when it runs out, and how
// many wrong tries it has had. Never the PIN.
//
// The rules:
//   - Only a yes from the server makes it or refreshes it (rememberPinForOffline,
//     called by PinGate). An unlock with no signal never extends it, so twelve
//     hours after the last check with signal it is over, however often it was
//     used in between.
//   - It is only consulted when the server cannot be reached (PinGate). With
//     signal the server stays the only judge.
//   - Five wrong tries and it is wiped; from then on only a check with signal
//     opens the lock. A try is counted BEFORE it is checked, so closing the app
//     halfway through a guess still spends it.
//   - It belongs to one person. Another login never uses it, and signing out,
//     switching accounts, changing or removing the PIN, and the server calling a
//     PIN wrong all wipe it.
//   - Past its twelve hours the salt and hash are deleted the next time Forge
//     starts or a PIN is tried, and a marker holding neither is left in their
//     place, so the lock can say "expired" instead of a vaguer "no signal".
//
// What it does NOT do is make a 4-digit PIN strong. Whoever copies this phone's
// storage can try all 10,000 PINs against the fingerprint on their own machine —
// minutes on a laptop, seconds on a gaming graphics card. The sign-in token in
// that same storage already opens Forge without any PIN, so what the fingerprint
// adds to that person's haul is the PIN itself, which matters if the crew member
// uses the same four digits somewhere else. The owner accepted that, for twelve
// hours after the last check with signal, so crews on no-signal sites can reach
// their clock.

export const OFFLINE_PIN_KEY = "wops-pin-offline";
export const OFFLINE_PIN_TTL_MS = 12 * 60 * 60 * 1000;
export const OFFLINE_PIN_MAX_TRIES = 5;
/**
 * A phone clock more than this far BEFORE the moment the unlock was made means
 * the date was moved back, and the unlock reads as expired. Loose enough for a
 * clock that corrects itself by a minute or two.
 */
export const OFFLINE_PIN_CLOCK_SKEW_MS = 5 * 60 * 1000;
/**
 * PBKDF2 rounds for one fingerprint. Measured 2026-09-24 on an Apple M2: 164 ms
 * in Chromium, 223 ms in Firefox, 222 ms in Node (600,000 — the backup seal's
 * count — took 50–72 ms, far below the aim). Estimated from single-core speed
 * ratios, not measured on a phone: ≈0.2–0.25 s on an iPhone 11–12, ≈0.4 s on a
 * mid-range Android, ≈0.6 s on a budget one. Stored with each fingerprint, so
 * changing it later needs no migration: an old one is checked at its own count
 * and replaced at the next check with signal.
 */
export const OFFLINE_PIN_ITERATIONS = 2_000_000;
/** No record may make a phone grind for longer than this many rounds. */
const MAX_ITERATIONS = 20_000_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

interface ActiveRecord {
  v: 1;
  userId: string;
  salt: string;
  hash: string;
  iterations: number;
  issuedAt: number;
  expiresAt: number;
  failures: number;
}

/** What is left once the twelve hours are up: whose it was, and nothing else. */
interface ExpiredRecord {
  v: 1;
  userId: string;
  expired: true;
}

type StoredRecord = ActiveRecord | ExpiredRecord;

export type OfflinePinCheck =
  /** The same PIN the server last accepted on this phone. */
  | { kind: "ok" }
  | { kind: "wrong"; triesLeft: number }
  /** That was the fifth wrong try; the fingerprint is gone. */
  | { kind: "locked" }
  /** Past its twelve hours (or the phone's date was moved back). */
  | { kind: "expired" }
  /** Nothing usable for this person on this phone. */
  | { kind: "none" };

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface OfflinePinDeps {
  storage: Store | null;
  subtle: SubtleCrypto | null;
  now: () => number;
  randomSalt: () => Uint8Array<ArrayBuffer>;
  iterations: number;
}

function defaultStorage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage switched off: there is simply no offline unlock
  }
}

function resolve(over: Partial<OfflinePinDeps> = {}): OfflinePinDeps {
  return {
    storage: "storage" in over ? (over.storage ?? null) : defaultStorage(),
    subtle: "subtle" in over ? (over.subtle ?? null) : (globalThis.crypto?.subtle ?? null),
    now: over.now ?? Date.now,
    randomSalt: over.randomSalt ?? (() => crypto.getRandomValues(new Uint8Array(SALT_BYTES))),
    iterations: over.iterations ?? OFFLINE_PIN_ITERATIONS,
  };
}

/**
 * Bumped by every wipe. A derivation takes a moment; one that finds this moved
 * while it worked (a sign-out, an account switch, a PIN change) keeps nothing
 * and unlocks nothing.
 */
let generation = 0;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function fingerprint(
  subtle: SubtleCrypto,
  userId: string,
  pin: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  // The person's id rides in the salt, so a fingerprint copied under another
  // login's name matches nobody's PIN.
  const id = enc.encode(userId);
  const salted = new Uint8Array(salt.length + id.length);
  salted.set(salt);
  salted.set(id, salt.length);
  const bits = await subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salted, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

/** Looks at every byte whatever the earlier ones said, so how long the check
 * takes says nothing about how close a guess came. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isCount(n: unknown, min: number, max = Number.MAX_SAFE_INTEGER): n is number {
  return Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
}

/** null when there is nothing; "corrupt" when there is something unusable. */
function read(storage: Store): StoredRecord | "corrupt" | null {
  let raw: string | null;
  try {
    raw = storage.getItem(OFFLINE_PIN_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (r?.v !== 1 || typeof r.userId !== "string" || !r.userId) return "corrupt";
    if (r.expired === true) return { v: 1, userId: r.userId, expired: true };
    if (
      typeof r.salt === "string" &&
      typeof r.hash === "string" &&
      isCount(r.iterations, 1, MAX_ITERATIONS) &&
      isCount(r.issuedAt, 0) &&
      isCount(r.expiresAt, 0) &&
      isCount(r.failures, 0)
    ) {
      return r as unknown as ActiveRecord;
    }
  } catch {
    /* not JSON */
  }
  return "corrupt";
}

function write(storage: Store, record: StoredRecord): boolean {
  try {
    storage.setItem(OFFLINE_PIN_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

function hasRunOut(record: ActiveRecord, now: number): boolean {
  return now >= record.expiresAt || now < record.issuedAt - OFFLINE_PIN_CLOCK_SKEW_MS;
}

/** Delete the salt and hash, keep only "this person's unlock ran out". */
function expire(storage: Store, userId: string): void {
  generation++;
  if (!write(storage, { v: 1, userId, expired: true })) {
    try {
      storage.removeItem(OFFLINE_PIN_KEY);
    } catch {
      /* nothing more that can be done */
    }
  }
}

/** Wipe the offline unlock from this phone, whoever it belonged to. */
export function forgetOfflinePin(over?: Partial<OfflinePinDeps>): void {
  generation++;
  try {
    resolve(over).storage?.removeItem(OFFLINE_PIN_KEY);
  } catch {
    /* storage switched off: there was nothing to wipe */
  }
}

/**
 * Keep the offline unlock only if it is this person's and inside its twelve
 * hours: another person's (an account switch) or an unreadable one is wiped,
 * and one that has run out keeps nothing but the marker.
 */
export function keepOfflinePinOnlyFor(userId: string, over?: Partial<OfflinePinDeps>): void {
  const d = resolve(over);
  if (!d.storage) return;
  const record = read(d.storage);
  if (record === null) return;
  if (record === "corrupt" || record.userId !== userId) {
    forgetOfflinePin(over);
    return;
  }
  if (!("expired" in record) && hasRunOut(record, d.now())) expire(d.storage, userId);
}

/**
 * Follow the sign-in on this phone. Called by App.tsx for the session found at
 * launch and for every change after it. Only SIGNED_OUT wipes outright: a
 * launch with no signal can hand back no session without anybody having signed
 * out (the token could not be refreshed), and that must not cost a crew member
 * the one thing that lets them in.
 */
export function syncOfflinePinWithAuth(
  event: string,
  userId: string | null,
  over?: Partial<OfflinePinDeps>,
): void {
  if (event === "SIGNED_OUT") {
    forgetOfflinePin(over);
    return;
  }
  if (userId) keepOfflinePinOnlyFor(userId, over);
}

/**
 * The server just accepted `pin` for `userId`: keep a fresh fingerprint for the
 * next twelve hours, replacing any older one and its wrong-try count. Never
 * rejects — with no fingerprint the lock simply stays shut when offline.
 */
export async function rememberPinForOffline(
  userId: string,
  pin: string,
  over?: Partial<OfflinePinDeps>,
): Promise<void> {
  const d = resolve(over);
  if (!d.storage || !d.subtle) return;
  const started = generation;
  const issuedAt = d.now();
  try {
    const salt = d.randomSalt();
    const hash = await fingerprint(d.subtle, userId, pin, salt, d.iterations);
    if (generation !== started) return;
    write(d.storage, {
      v: 1,
      userId,
      salt: toBase64(salt),
      hash: toBase64(hash),
      iterations: d.iterations,
      issuedAt,
      expiresAt: issuedAt + OFFLINE_PIN_TTL_MS,
      failures: 0,
    });
  } catch {
    /* no fingerprint this time */
  }
}

/**
 * Check `pin` against this phone's offline unlock, for when the server cannot
 * be reached. PinGate calls this only after check_my_pin failed to get an
 * answer; never with signal.
 */
export async function checkPinOffline(
  userId: string,
  pin: string,
  over?: Partial<OfflinePinDeps>,
): Promise<OfflinePinCheck> {
  const d = resolve(over);
  if (!d.storage || !d.subtle) return { kind: "none" };
  const record = read(d.storage);
  if (record === null) return { kind: "none" };
  if (record === "corrupt" || record.userId !== userId) {
    forgetOfflinePin(over);
    return { kind: "none" };
  }
  if ("expired" in record) return { kind: "expired" };
  if (hasRunOut(record, d.now())) {
    expire(d.storage, userId);
    return { kind: "expired" };
  }

  // Spend the try first. One that cannot be counted is not checked.
  const tries = record.failures + 1;
  if (!write(d.storage, { ...record, failures: tries })) return { kind: "none" };
  const started = generation;
  let match: boolean;
  try {
    const guess = await fingerprint(d.subtle, userId, pin, fromBase64(record.salt), record.iterations);
    match = sameBytes(guess, fromBase64(record.hash));
  } catch {
    forgetOfflinePin(over);
    return { kind: "none" };
  }
  // Wiped while it was being checked (signed out, switched, PIN changed).
  if (generation !== started) return { kind: "none" };
  if (match) {
    write(d.storage, { ...record, failures: 0 });
    return { kind: "ok" };
  }
  if (tries >= OFFLINE_PIN_MAX_TRIES) {
    forgetOfflinePin(over);
    return { kind: "locked" };
  }
  return { kind: "wrong", triesLeft: OFFLINE_PIN_MAX_TRIES - tries };
}

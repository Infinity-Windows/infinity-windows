// The shift-long offline unlock, against real Web Crypto (2026-09-24).
//
// Every rule the owner set is a test here: only a check with signal makes the
// fingerprint, the PIN itself is never stored, the same PIN opens the lock for
// twelve hours with no signal, wrong tries are counted and five wipe it, it
// belongs to one person, and signing out or switching accounts wipes it. PinGate
// decides WHEN to consult it (PinGate.test.tsx); this file proves what it does.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_PIN_ITERATIONS,
  OFFLINE_PIN_KEY,
  OFFLINE_PIN_TTL_MS,
  checkPinOffline,
  forgetOfflinePin,
  keepOfflinePinOnlyFor,
  rememberPinForOffline,
  syncOfflinePinWithAuth,
  type OfflinePinDeps,
} from "./offlinePin";
import { rememberSignedIn } from "./signedIn";

const ANA = "00000000-0000-4000-8000-0000000000a1";
const BEN = "00000000-0000-4000-8000-0000000000b2";
const PIN = "4821";
const HOUR = 60 * 60 * 1000;
/** 7 AM in Denver, the start of a shift. */
const T0 = Date.UTC(2026, 8, 24, 13, 0, 0);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

let store: ReturnType<typeof memoryStorage>;
let clock: number;

/**
 * This phone. A fixed salt keeps every stored byte the same run to run, and a
 * thousand rounds keeps the suite quick — the real count is used, and checked,
 * in the first test.
 */
function phone(over: Partial<OfflinePinDeps> = {}): Partial<OfflinePinDeps> {
  return {
    storage: store,
    now: () => clock,
    iterations: 1_000,
    randomSalt: () => new Uint8Array(16).fill(7),
    ...over,
  };
}

const saved = () => JSON.parse(store.map.get(OFFLINE_PIN_KEY) ?? "null") as Record<string, unknown> | null;
const bytes = (b64: unknown) => Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));

beforeEach(() => {
  store = memoryStorage();
  clock = T0;
  // Ana is signed in on this phone, as App tells lib/signedIn at launch.
  rememberSignedIn({ user: { id: ANA } });
});

describe("after a check with signal", () => {
  it("keeps a slow, salted fingerprint for this person for twelve hours — never the PIN", async () => {
    // The real round count, as a phone runs it.
    await rememberPinForOffline(ANA, PIN, {
      storage: store,
      now: () => clock,
      randomSalt: () => new Uint8Array(16).fill(7),
    });

    expect([...store.map.keys()]).toEqual([OFFLINE_PIN_KEY]);
    const record = saved()!;
    expect(Object.keys(record).sort()).toEqual(
      ["expiresAt", "failures", "hash", "issuedAt", "iterations", "salt", "userId", "v"],
    );
    expect(record).toMatchObject({
      v: 1,
      userId: ANA,
      iterations: OFFLINE_PIN_ITERATIONS,
      issuedAt: T0,
      expiresAt: T0 + OFFLINE_PIN_TTL_MS,
      failures: 0,
    });
    expect(bytes(record.salt)).toHaveLength(16);
    expect(bytes(record.hash)).toHaveLength(32);
    // Not the PIN, in any spelling, anywhere on the phone.
    for (const value of store.map.values()) {
      expect(value).not.toContain(PIN);
      expect(value).not.toContain(btoa(PIN));
    }
    // …and it is what opens the lock with no signal.
    expect(await checkPinOffline(ANA, PIN, { storage: store, now: () => clock })).toEqual({ kind: "ok" });
  });

  it("lasts twelve hours and never uses fewer rounds than the backup seal's 600,000", () => {
    expect(OFFLINE_PIN_TTL_MS).toBe(12 * HOUR);
    expect(OFFLINE_PIN_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  it("a fresh check with signal replaces it: new salt, new twelve hours, wrong tries forgotten", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    await checkPinOffline(ANA, "1111", phone());
    await checkPinOffline(ANA, "2222", phone());
    expect(saved()!.failures).toBe(2);

    clock = T0 + 3 * HOUR;
    await rememberPinForOffline(ANA, PIN, phone({ randomSalt: () => new Uint8Array(16).fill(9) }));
    expect(saved()).toMatchObject({ issuedAt: T0 + 3 * HOUR, expiresAt: T0 + 15 * HOUR, failures: 0 });
    expect(bytes(saved()!.salt)).toEqual(new Uint8Array(16).fill(9));
  });
});

describe("with no signal", () => {
  it("the same PIN opens the lock any time inside the twelve hours", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    clock = T0 + 12 * HOUR - 60_000;
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "ok" });
  });

  it("a wrong PIN is refused and counted, and the count survives closing the app", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    expect(await checkPinOffline(ANA, "1111", phone())).toEqual({ kind: "wrong", triesLeft: 4 });
    expect(saved()!.failures).toBe(1);
    // A relaunch is a fresh start for everything except the phone's storage.
    expect(await checkPinOffline(ANA, "0000", phone())).toEqual({ kind: "wrong", triesLeft: 3 });
  });

  it("the right PIN after a wrong one opens the lock and starts the count again", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    await checkPinOffline(ANA, "1111", phone());
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "ok" });
    expect(saved()!.failures).toBe(0);
    expect(await checkPinOffline(ANA, "1111", phone())).toEqual({ kind: "wrong", triesLeft: 4 });
  });

  it("five wrong tries wipe it, and after that even the right PIN needs signal", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    for (const [guess, left] of [["1111", 4], ["2222", 3], ["3333", 2], ["4444", 1]] as const) {
      expect(await checkPinOffline(ANA, guess, phone())).toEqual({ kind: "wrong", triesLeft: left });
    }
    expect(await checkPinOffline(ANA, "5555", phone())).toEqual({ kind: "locked" });
    expect(store.map.size).toBe(0);
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "none" });
  });

  it("spends the try before checking it, so closing the app mid-guess still counts", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    const subtle = globalThis.crypto.subtle;
    let failuresWhileChecking: unknown;
    const watching = {
      importKey: subtle.importKey.bind(subtle),
      deriveBits: (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
        failuresWhileChecking = saved()!.failures;
        return subtle.deriveBits(...args);
      },
    } as unknown as SubtleCrypto;
    await checkPinOffline(ANA, "1111", phone({ subtle: watching }));
    expect(failuresWhileChecking).toBe(1);
  });

  it("twelve hours after the last check with signal it fails closed, and the salt and hash are deleted", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    clock = T0 + 12 * HOUR;
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "expired" });
    expect(saved()).toEqual({ v: 1, userId: ANA, expired: true });
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "expired" });

    // A check with signal starts a new twelve hours.
    await rememberPinForOffline(ANA, PIN, phone());
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "ok" });
  });

  it("moving the phone's date back does not stretch it; a clock a minute or two off is fine", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    clock = T0 - 2 * 60_000;
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "ok" });
    clock = T0 - HOUR;
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "expired" });
    expect(saved()).toEqual({ v: 1, userId: ANA, expired: true });
  });

  it("another account can't use it — and finding one wipes it", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    expect(await checkPinOffline(BEN, PIN, phone())).toEqual({ kind: "none" });
    expect(store.map.size).toBe(0);
  });

  it("a fingerprint relabelled with another person's id matches nobody's PIN", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    store.map.set(OFFLINE_PIN_KEY, JSON.stringify({ ...saved(), userId: BEN }));
    // Ben is the one at the lock, trying Ana's PIN on it.
    rememberSignedIn({ user: { id: BEN } });
    expect(await checkPinOffline(BEN, PIN, phone())).toEqual({ kind: "wrong", triesLeft: 4 });
  });

  it("an unreadable record is wiped, not trusted", async () => {
    store.map.set(OFFLINE_PIN_KEY, "{not json");
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "none" });
    expect(store.map.size).toBe(0);

    await rememberPinForOffline(ANA, PIN, phone());
    // A round count that would keep the phone busy for minutes.
    store.map.set(OFFLINE_PIN_KEY, JSON.stringify({ ...saved(), iterations: 1_000_000_000 }));
    expect(await checkPinOffline(ANA, PIN, phone())).toEqual({ kind: "none" });
    expect(store.map.size).toBe(0);
  });

  it("with storage switched off there is no offline unlock, and nothing breaks", async () => {
    await expect(rememberPinForOffline(ANA, PIN, phone({ storage: null }))).resolves.toBeUndefined();
    expect(await checkPinOffline(ANA, PIN, phone({ storage: null }))).toEqual({ kind: "none" });
  });

  it("a try that cannot be counted is not checked", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    const full = { ...store, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(await checkPinOffline(ANA, PIN, phone({ storage: full }))).toEqual({ kind: "none" });
  });
});

describe("following the sign-in on this phone", () => {
  it("signing out wipes it", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    syncOfflinePinWithAuth("SIGNED_OUT", null, phone());
    expect(store.map.size).toBe(0);
  });

  it("another login on this phone wipes it; the same person keeps it", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    syncOfflinePinWithAuth("TOKEN_REFRESHED", ANA, phone());
    expect(saved()).toMatchObject({ userId: ANA, failures: 0 });
    syncOfflinePinWithAuth("SIGNED_IN", BEN, phone());
    expect(store.map.size).toBe(0);
  });

  it("a launch that comes back with no session is not a sign-out, and keeps it", async () => {
    // What a relaunch with no signal and a stale token looks like.
    await rememberPinForOffline(ANA, PIN, phone());
    syncOfflinePinWithAuth("INITIAL_SESSION", null, phone());
    expect(saved()).toMatchObject({ userId: ANA });
  });

  it("at launch, one past its twelve hours keeps nothing but the marker", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    clock = T0 + 13 * HOUR;
    keepOfflinePinOnlyFor(ANA, phone());
    expect(saved()).toEqual({ v: 1, userId: ANA, expired: true });
  });
});

describe("a wipe in the middle of the work", () => {
  it("signing out while the fingerprint is being made keeps nothing", async () => {
    const making = rememberPinForOffline(ANA, PIN, phone());
    forgetOfflinePin(phone());
    await making;
    expect(store.map.size).toBe(0);
  });

  it("signing out while a PIN is being checked does not unlock", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    const checking = checkPinOffline(ANA, PIN, phone());
    forgetOfflinePin(phone());
    expect(await checking).toEqual({ kind: "none" });
    expect(store.map.size).toBe(0);
  });

  // Codex's review of #651 (2026-09-25): the first fingerprint on a phone has
  // nothing stored yet, so an account switch found nothing to wipe — and the
  // derivation still in flight for the person before wrote theirs after it.
  it("another login before the first fingerprint is written keeps nothing, even with nothing stored yet", async () => {
    expect(store.map.size).toBe(0);
    const making = rememberPinForOffline(ANA, PIN, phone());
    // What App does when Ben signs in on this phone.
    rememberSignedIn({ user: { id: BEN } });
    syncOfflinePinWithAuth("SIGNED_IN", BEN, phone());
    await making;
    expect(store.map.size).toBe(0);
  });
});

describe("five tries in all", () => {
  // Codex's review of #651 (2026-09-25): a try is counted before it is
  // checked, but nothing looked at the count before the NEXT check started.
  // Five checks the app was closed in the middle of left five tries spent,
  // and the sixth guess was still checked — and the right PIN reset the count.
  it("five tries spent by checks that never finished: the next is refused and wiped before anything is derived", async () => {
    await rememberPinForOffline(ANA, PIN, phone());
    const subtle = globalThis.crypto.subtle;
    let derivations = 0;
    const neverFinishes = {
      importKey: subtle.importKey.bind(subtle),
      deriveBits: () => {
        derivations++;
        return new Promise<ArrayBuffer>(() => {});
      },
    } as unknown as SubtleCrypto;
    // Five guesses, each counted, none finished: the app was closed each time.
    for (let i = 0; i < 5; i++) void checkPinOffline(ANA, "0000", phone({ subtle: neverFinishes }));
    expect(saved()!.failures).toBe(5);
    await vi.waitFor(() => expect(derivations).toBe(5));

    const counting = {
      importKey: subtle.importKey.bind(subtle),
      deriveBits: (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
        derivations++;
        return subtle.deriveBits(...args);
      },
    } as unknown as SubtleCrypto;
    // Even the right PIN: five is five.
    expect(await checkPinOffline(ANA, PIN, phone({ subtle: counting }))).toEqual({ kind: "locked" });
    expect(derivations).toBe(5);
    expect(store.map.size).toBe(0);
  });
});

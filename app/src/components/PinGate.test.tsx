// @vitest-environment happy-dom
//
// The device lock, reopened with no signal (2026-09-24).
//
// PinGate asks the server whether this person has a PIN, and the answer used to
// live only in memory. Reopening the app in a dead zone therefore had nothing to
// go on: the lock either sat on "Checking device lock…" for as long as the read
// hung, or — when the read failed — read the failure as "no PIN" and opened for
// somebody who has one. A security control that fails open is not a control.
//
// The lock now works from the last answer this phone got (the key is kept on the
// phone, see lib/queryKeys.ts): a PIN account still gets the PIN pad, a no-PIN
// account goes straight in, and a phone that has never had an answer says so in
// plain words, with a Try again button, instead of spinning.
//
// With signal the server alone judges the PIN. When it cannot be reached, the
// owner's shift-long offline unlock (lib/offlinePin.ts, proven on its own in
// offlinePin.test.ts) may: a PIN the server accepted on this phone in the last
// twelve hours opens the lock again. It is mocked here — what this file proves
// is WHEN the lock asks it, and what it tells the person.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-4000-8000-0000000000a1";
/** Somebody else with a login on the same phone. */
const BEN = "00000000-0000-4000-8000-0000000000b2";
const PROFILE = { id: USER, display_name: "Ana Lopez", role: "installer", language: "en" };
const HOURS_AGO = (h: number) => Date.now() - h * 60 * 60 * 1000;

// What a read looks like when the phone has no signal: postgrest-js hands the
// failure back as an error, and myPinStatus throws it (myPinStatus.test.ts).
const NO_SIGNAL = { message: "TypeError: Failed to fetch", code: "" };
const NEVER = () => new Promise<never>(() => {});
/**
 * Every call into the offline unlock carries the sign-in the check began in —
 * this person's — so an answer that lands after a sign-out is held to it.
 */
const HELD_TO_USER = { signIn: expect.objectContaining({ userId: USER }) };

const api = vi.hoisted(() => ({
  myPinStatus: vi.fn(),
  checkMyPin: vi.fn(),
  setMyPin: vi.fn(),
  getMyProfile: vi.fn(),
  getRealProfile: vi.fn(),
  setMyLanguage: vi.fn(),
}));
vi.mock("../lib/install/api", () => ({
  myPinStatus: (...a: unknown[]) => api.myPinStatus(...a),
  checkMyPin: (...a: unknown[]) => api.checkMyPin(...a),
  setMyPin: (...a: unknown[]) => api.setMyPin(...a),
  getMyProfile: (...a: unknown[]) => api.getMyProfile(...a),
  getRealProfile: (...a: unknown[]) => api.getRealProfile(...a),
  setMyLanguage: (...a: unknown[]) => api.setMyLanguage(...a),
}));
vi.mock("../lib/toast", () => ({ toastError: vi.fn() }));

const offline = vi.hoisted(() => ({
  rememberPinForOffline: vi.fn(),
  checkPinOffline: vi.fn(),
  forgetOfflinePin: vi.fn(),
  syncOfflinePinWithAuth: vi.fn(),
}));
vi.mock("../lib/offlinePin", () => ({
  rememberPinForOffline: (...a: unknown[]) => offline.rememberPinForOffline(...a),
  checkPinOffline: (...a: unknown[]) => offline.checkPinOffline(...a),
  forgetOfflinePin: (...a: unknown[]) => offline.forgetOfflinePin(...a),
  syncOfflinePinWithAuth: (...a: unknown[]) => offline.syncOfflinePinWithAuth(...a),
}));

const { PinGate, PinSetter } = await import("./PinGate");
const { rememberSignedIn } = await import("../lib/signedIn");
const { syncPinLockWithAuth } = await import("../lib/pinGate");
const { LanguageProvider } = await import("../lib/i18n");

let container: HTMLElement;
let root: Root;
let qc: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* happy-dom always has storage */
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // The app's own query defaults (lib/queryClient.ts), minus the automatic
  // retry so each test decides exactly what every read answers.
  qc = new QueryClient({
    defaultOptions: {
      queries: { networkMode: "offlineFirst", staleTime: 30_000, retry: false },
    },
  });
  api.getMyProfile.mockResolvedValue(PROFILE);
  api.getRealProfile.mockResolvedValue(null);
  offline.rememberPinForOffline.mockResolvedValue(undefined);
  // This phone has no offline unlock unless a test says otherwise.
  offline.checkPinOffline.mockResolvedValue({ kind: "none" });
  // Ana is signed in, as App tells lib/signedIn before it draws the lock.
  rememberSignedIn({ user: { id: USER } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
  rememberSignedIn(null);
});

/**
 * Let queries settle and timers run, `ms` of fake time at a go. Then a few
 * short rounds, because one answer can enable the next read (the profile, then
 * the lock) and each hop is a render plus a scheduled notify — a tenth of a
 * second in all, far inside the lock's wait, so no test crosses it by accident.
 */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let round = 0; round < 10; round++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }
}

/**
 * What an offline relaunch restores from the phone before anything is asked:
 * the profile, and — when this phone ever got one — the lock's last answer.
 */
function savedOnPhone(pin?: boolean) {
  qc.setQueryData(["myProfile"], PROFILE, { updatedAt: HOURS_AGO(3) });
  if (pin !== undefined) qc.setQueryData(["myPinStatus", USER], pin, { updatedAt: HOURS_AGO(3) });
}

async function mount(opts: { spanish?: boolean } = {}) {
  const gate = (
    <PinGate userId={USER}>
      <p>THE APP</p>
    </PinGate>
  );
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        {opts.spanish ? <LanguageProvider>{gate}</LanguageProvider> : gate}
      </QueryClientProvider>,
    );
  });
  await settle();
}

const text = () => container.textContent ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button reading "${label}" in: ${text()}`);
  return found as HTMLButtonElement;
}

async function typePin(pin: string) {
  for (const digit of pin) {
    await act(async () => button(digit).click());
  }
  await settle();
}

describe("PinGate with signal (unchanged)", () => {
  it("checks, then asks a PIN account for the PIN", async () => {
    let answer: (v: boolean) => void = () => {};
    api.myPinStatus.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));
    await mount();
    expect(text()).toContain("Checking device lock…");
    expect(text()).not.toContain("THE APP");

    await act(async () => answer(true));
    await settle();
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).toContain("Ana Lopez");
    expect(text()).not.toContain("THE APP");
  });

  it("lets a no-PIN account straight in", async () => {
    api.myPinStatus.mockResolvedValue(false);
    await mount();
    expect(text()).toContain("THE APP");
  });

  it("unlocks on the right PIN and says so on a wrong one — the server alone judges", async () => {
    api.myPinStatus.mockResolvedValue(true);
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "wrong" });
    api.checkMyPin.mockResolvedValueOnce({ ok: true });
    await mount();

    await typePin("1111");
    expect(text()).toContain("Wrong PIN — try again");
    expect(text()).not.toContain("THE APP");
    // A no from the server: the copy kept for offline use can no longer be
    // trusted to match, so it goes.
    expect(offline.forgetOfflinePin).toHaveBeenCalledTimes(1);

    await typePin("4821");
    expect(api.checkMyPin).toHaveBeenLastCalledWith("4821");
    expect(text()).toContain("THE APP");
    // A yes keeps this PIN for offline use, for this person, for the shift.
    expect(offline.rememberPinForOffline).toHaveBeenCalledWith(USER, "4821", HELD_TO_USER);
    // With an answer from the server, the phone's copy is never asked.
    expect(offline.checkPinOffline).not.toHaveBeenCalled();
  });
});

describe("PinGate reopened with no signal", () => {
  it("never sits on “Checking device lock…”: a read that hangs gives way to a plain message", async () => {
    // The field report: a phone that has never had an answer, and a read that
    // neither answers nor fails.
    savedOnPhone();
    api.myPinStatus.mockImplementation(NEVER);
    await mount();
    expect(text()).toContain("Checking device lock…");

    await settle(10_000);
    expect(text()).not.toContain("Checking device lock…");
    expect(text()).toContain("You're offline");
    expect(text()).toContain("Connect to the internet once so Forge can check your device lock");
    expect(() => button("Try again")).not.toThrow();
    expect(text()).not.toContain("THE APP");
  });

  it("(a) a PIN account still gets the PIN pad from the saved answer — no spinner, no way round it", async () => {
    savedOnPhone(true);
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    await mount();
    expect(text()).not.toContain("Checking device lock…");
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("THE APP");

    // A failed re-check must not wear the saved answer down to "no PIN".
    await settle(60_000);
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("THE APP");
  });

  it("(a) shows the PIN pad straight away even while the re-check hangs", async () => {
    savedOnPhone(true);
    api.myPinStatus.mockImplementation(NEVER);
    await mount();
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("Checking device lock…");
  });

  it("(a) with no offline unlock on this phone the PIN cannot be checked, so the lock stays shut and says why", async () => {
    savedOnPhone(true);
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "network" });
    await mount();

    await typePin("4821");
    expect(offline.checkPinOffline).toHaveBeenCalledWith(USER, "4821", HELD_TO_USER);
    expect(text()).toContain("No signal. Your PIN is checked online");
    expect(text()).not.toContain("THE APP");

    // Signal is back: Try again sends the same four digits — no retyping.
    api.checkMyPin.mockResolvedValueOnce({ ok: true });
    await act(async () => button("Try again").click());
    await settle();
    expect(api.checkMyPin).toHaveBeenLastCalledWith("4821");
    expect(text()).toContain("THE APP");
  });

  it("(b) a no-PIN account goes straight in from the saved answer", async () => {
    savedOnPhone(false);
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    await mount();
    expect(text()).toContain("THE APP");
    expect(text()).not.toContain("Checking device lock…");
  });

  it("(c) a phone that never got an answer stays locked and says so, and Try again works once signal is back", async () => {
    savedOnPhone();
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    await mount();
    expect(text()).toContain("You're offline");
    expect(text()).not.toContain("Checking device lock…");
    expect(text()).not.toContain("THE APP");

    api.myPinStatus.mockResolvedValue(false);
    await act(async () => button("Try again").click());
    await settle();
    expect(text()).toContain("THE APP");
  });

  it("(c) …and a PIN account that gets its answer on Try again is asked for the PIN", async () => {
    savedOnPhone();
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    await mount();
    expect(text()).toContain("You're offline");

    api.myPinStatus.mockResolvedValue(true);
    await act(async () => button("Try again").click());
    await settle();
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("THE APP");
  });

  it("speaks Spanish to a Spanish reader", async () => {
    localStorage.setItem("infinity.language", "es");
    savedOnPhone();
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    await mount({ spanish: true });
    expect(text()).toContain("Estás sin señal");
    expect(() => button("Intentar de nuevo")).not.toThrow();
  });
});

describe("the shift-long offline unlock (owner's decision, 2026-09-24)", () => {
  /** A PIN account on a phone with no signal: the pad, from the saved answer. */
  async function padWithNoSignal() {
    savedOnPhone(true);
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    await mount();
    expect(text()).toContain("Enter your 4-digit PIN");
  }

  it("the same PIN as the last yes on this phone opens the lock — and does not stretch the twelve hours", async () => {
    await padWithNoSignal();
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "network" });
    offline.checkPinOffline.mockResolvedValueOnce({ kind: "ok" });

    await typePin("4821");
    expect(offline.checkPinOffline).toHaveBeenCalledWith(USER, "4821", HELD_TO_USER);
    expect(text()).toContain("THE APP");
    // Only a yes from the server makes or refreshes the offline unlock.
    expect(offline.rememberPinForOffline).not.toHaveBeenCalled();
  });

  it("a wrong PIN with no signal is refused, and says how many tries are left", async () => {
    await padWithNoSignal();
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "network" });
    offline.checkPinOffline.mockResolvedValueOnce({ kind: "wrong", triesLeft: 3 });

    await typePin("1111");
    expect(text()).toContain("Wrong PIN. Tries left without signal: 3");
    expect(text()).not.toContain("THE APP");
    // Nothing to send again: those digits were judged.
    expect(() => button("Try again")).toThrow();
  });

  it("the fifth wrong try says the offline unlock is gone", async () => {
    await padWithNoSignal();
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "network" });
    offline.checkPinOffline.mockResolvedValueOnce({ kind: "locked" });

    await typePin("5555");
    expect(text()).toContain("Too many wrong tries without signal. Connect to the internet to check your PIN.");
    expect(text()).not.toContain("THE APP");
  });

  it("past its twelve hours it fails closed and says so; Try again works once signal is back", async () => {
    await padWithNoSignal();
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "network" });
    offline.checkPinOffline.mockResolvedValueOnce({ kind: "expired" });

    await typePin("4821");
    expect(text()).toContain("Your offline unlock has expired — connect to check your PIN.");
    expect(text()).not.toContain("THE APP");

    api.checkMyPin.mockResolvedValueOnce({ ok: true });
    await act(async () => button("Try again").click());
    await settle();
    expect(api.checkMyPin).toHaveBeenLastCalledWith("4821");
    expect(text()).toContain("THE APP");
    expect(offline.rememberPinForOffline).toHaveBeenCalledWith(USER, "4821", HELD_TO_USER);
  });

  it("a server that answers with an error is not a dead zone: the phone's copy is not asked", async () => {
    api.myPinStatus.mockResolvedValue(true);
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "error" });
    await mount();

    await typePin("4821");
    expect(text()).toContain("Forge couldn't check your PIN. Try again.");
    expect(text()).not.toContain("THE APP");
    expect(offline.checkPinOffline).not.toHaveBeenCalled();
  });

  it("the server saying there is no PIN any more wipes the offline unlock", async () => {
    api.myPinStatus.mockResolvedValue(true);
    await mount();
    expect(offline.forgetOfflinePin).not.toHaveBeenCalled();

    api.myPinStatus.mockResolvedValue(false);
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["myPinStatus"] });
    });
    await settle();
    expect(offline.forgetOfflinePin).toHaveBeenCalled();
    expect(text()).toContain("THE APP");
  });

  it("changing or removing the PIN on the Crew screen wipes the offline unlock kept for the old one", async () => {
    rememberSignedIn({ user: { id: USER } });
    api.myPinStatus.mockResolvedValue(true);
    api.setMyPin.mockResolvedValue(undefined);
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <PinSetter />
        </QueryClientProvider>,
      );
    });
    await settle();

    const input = container.querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "1234");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save PIN").click());
    await settle();
    expect(api.setMyPin).toHaveBeenLastCalledWith("1234");
    expect(offline.forgetOfflinePin).toHaveBeenCalledTimes(1);

    await act(async () => button("Clear").click());
    await settle();
    expect(api.setMyPin).toHaveBeenLastCalledWith("");
    expect(offline.forgetOfflinePin).toHaveBeenCalledTimes(2);
    rememberSignedIn(null);
  });
});

// Codex's review of #651 (2026-09-25). The unlock used to be a bare "1" in
// this tab's storage, read by whoever was signed in next, and the lock's React
// state carried over from one login to the next. An unlock is one person's.
describe("an unlock belongs to the person who unlocked", () => {
  it.each([
    ["the old bare “1”", "1"],
    ["somebody else's", BEN],
  ])("an unlock kept in this tab by %s does not open the lock", async (_label, kept) => {
    api.myPinStatus.mockResolvedValue(true);
    sessionStorage.setItem("wops-pin-unlocked", kept);
    await mount();
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("THE APP");
    expect(api.checkMyPin).not.toHaveBeenCalled();
    expect(offline.checkPinOffline).not.toHaveBeenCalled();
  });

  it("the lock drawn for somebody else starts shut, with nothing the first person typed", async () => {
    api.myPinStatus.mockResolvedValue(true);
    api.checkMyPin.mockResolvedValue({ ok: true });
    await mount();
    await typePin("4821");
    expect(text()).toContain("THE APP");
    api.checkMyPin.mockClear();

    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <PinGate userId={BEN}>
            <p>OTHER APP</p>
          </PinGate>
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(text()).not.toContain("OTHER APP");
    expect(text()).not.toContain("THE APP");
    expect(api.checkMyPin).not.toHaveBeenCalled();
    const typed = container.querySelector<HTMLInputElement>("input.pin-input");
    expect(typed?.value ?? "").toBe("");
  });
});

// Codex's review of #651 (2026-09-25): a yes from the server that landed after
// the lock was gone still kept a fresh offline unlock for the person before.
describe("a check that lands after its lock is gone", () => {
  it("a yes from the server after the lock was taken down keeps nothing and lets nobody in", async () => {
    api.myPinStatus.mockResolvedValue(true);
    let answer!: (value: { ok: true }) => void;
    api.checkMyPin.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await mount();
    await typePin("4821");
    expect(text()).toContain("Checking your PIN…");

    // App draws the sign-in screen when SIGNED_OUT arrives, and the lock goes.
    act(() => root.render(<div>Signed out</div>));
    await act(async () => answer({ ok: true }));
    await settle();
    expect(offline.rememberPinForOffline).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("wops-pin-unlocked")).toBeNull();
  });
});

/**
 * What App.tsx does at every auth event: tell lib/signedIn who is signed in
 * now, then the lock (syncPinLockWithAuth). The offline unlock's own part is
 * mocked here and proven in offlinePin.test.ts.
 */
function authSays(event: string, userId: string | null) {
  rememberSignedIn(userId ? { user: { id: userId } } : null);
  syncPinLockWithAuth(event, userId);
}

/** App draws the lock for whoever is signed in now. */
async function lockFor(userId: string, app: string) {
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <PinGate userId={userId}>
          <p>{app}</p>
        </PinGate>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

describe("signing out and switching accounts, as App does it", () => {
  it("Ana unlocks, signs out, and Ben signs in on the same tab: Ben is asked for his own PIN", async () => {
    api.myPinStatus.mockResolvedValue(true);
    api.checkMyPin.mockResolvedValue({ ok: true });
    await mount();
    await typePin("4821");
    expect(text()).toContain("THE APP");
    expect(sessionStorage.getItem("wops-pin-unlocked")).toBe(USER);

    authSays("SIGNED_OUT", null);
    act(() => root.render(<p>Sign in</p>));
    expect(sessionStorage.getItem("wops-pin-unlocked")).toBeNull();

    api.checkMyPin.mockClear();
    authSays("SIGNED_IN", BEN);
    await lockFor(BEN, "BEN'S APP");
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("BEN'S APP");
    expect(api.checkMyPin).not.toHaveBeenCalled();
  });

  it("the same person signing out and back in is asked for the PIN again", async () => {
    api.myPinStatus.mockResolvedValue(true);
    api.checkMyPin.mockResolvedValue({ ok: true });
    await mount();
    await typePin("4821");
    expect(text()).toContain("THE APP");

    authSays("SIGNED_OUT", null);
    act(() => root.render(<p>Sign in</p>));
    authSays("SIGNED_IN", USER);
    await lockFor(USER, "THE APP");
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("THE APP");
  });

  it("another login with no sign-out between gets a fresh lock, and the tab's unlock is gone", async () => {
    api.myPinStatus.mockResolvedValue(true);
    api.checkMyPin.mockResolvedValue({ ok: true });
    await mount();
    await typePin("4821");
    expect(text()).toContain("THE APP");

    authSays("SIGNED_IN", BEN);
    await lockFor(BEN, "BEN'S APP");
    expect(sessionStorage.getItem("wops-pin-unlocked")).toBeNull();
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("BEN'S APP");
  });

  it("a check started for Ana that lands after Ben signed in never unlocks Ben", async () => {
    api.myPinStatus.mockResolvedValue(true);
    let answer!: (value: { ok: true }) => void;
    api.checkMyPin.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await mount();
    await typePin("4821");
    expect(text()).toContain("Checking your PIN…");

    authSays("SIGNED_IN", BEN);
    await lockFor(BEN, "BEN'S APP");
    expect(text()).toContain("Enter your 4-digit PIN");

    await act(async () => answer({ ok: true }));
    await settle();
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("BEN'S APP");
    expect(sessionStorage.getItem("wops-pin-unlocked")).toBeNull();
    expect(offline.rememberPinForOffline).not.toHaveBeenCalled();
  });

  it("a yes that lands after sign-out lets nobody in even if the lock is still on screen", async () => {
    // The mark, on its own: App has heard SIGNED_OUT but not yet drawn the
    // sign-in screen when the server's answer arrives.
    api.myPinStatus.mockResolvedValue(true);
    let answer!: (value: { ok: true }) => void;
    api.checkMyPin.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await mount();
    await typePin("4821");

    authSays("SIGNED_OUT", null);
    await act(async () => answer({ ok: true }));
    await settle();
    expect(text()).not.toContain("THE APP");
    expect(sessionStorage.getItem("wops-pin-unlocked")).toBeNull();
    expect(offline.rememberPinForOffline).not.toHaveBeenCalled();
  });

  it("a check dropped while the same person's lock stays drawn hands the pad back empty", async () => {
    // Signed out and straight back in (another tab, say) before App redrew:
    // the same person's lock is still on screen when the old answer lands.
    api.myPinStatus.mockResolvedValue(true);
    let answer!: (value: { ok: true }) => void;
    api.checkMyPin.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await mount();
    await typePin("4821");
    authSays("SIGNED_OUT", null);
    authSays("SIGNED_IN", USER);

    await act(async () => answer({ ok: true }));
    await settle();
    expect(text()).not.toContain("THE APP");
    expect(container.querySelector<HTMLInputElement>("input.pin-input")?.value).toBe("");

    // The pad takes digits again, and a check made now counts.
    api.checkMyPin.mockResolvedValueOnce({ ok: true });
    await typePin("4821");
    expect(api.checkMyPin).toHaveBeenCalledTimes(2);
    expect(text()).toContain("THE APP");
  });

  it("an offline yes that lands after sign-out lets nobody in", async () => {
    savedOnPhone(true);
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "network" });
    let verdict!: (value: { kind: "ok" }) => void;
    offline.checkPinOffline.mockImplementationOnce(() => new Promise((resolve) => (verdict = resolve)));
    await mount();
    await typePin("4821");
    expect(offline.checkPinOffline).toHaveBeenCalledWith(USER, "4821", HELD_TO_USER);

    authSays("SIGNED_OUT", null);
    await act(async () => verdict({ kind: "ok" }));
    await settle();
    expect(text()).not.toContain("THE APP");
    expect(sessionStorage.getItem("wops-pin-unlocked")).toBeNull();
  });

  it("a PIN-status answer that lands after another login is not kept as this person's", async () => {
    savedOnPhone(true);
    let answer!: (value: boolean) => void;
    api.myPinStatus.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await mount();
    expect(text()).toContain("Enter your 4-digit PIN");

    // Ben signs in while Ana's re-check is out; it may have gone as Ben.
    authSays("SIGNED_IN", BEN);
    await act(async () => answer(false));
    await settle();
    expect(qc.getQueryData(["myPinStatus", USER])).toBe(true);
    expect(offline.forgetOfflinePin).not.toHaveBeenCalled();
  });
});

// Codex's review of #651 (2026-09-25): "the function is missing" is also what
// PostgREST says about a stale schema cache, while the function is there and
// the person has a PIN. install/api.ts now throws on it, marked as an answer
// from the server (reason "error") rather than no signal.
describe("a status read the server answers without a yes or a no", () => {
  const MISSING_FUNCTION = {
    message: "Could not find the function public.my_pin_status in the schema cache",
    code: "PGRST202",
    reason: "error",
  };

  it("never wears a saved yes down: the pad stays and the offline unlock is not wiped", async () => {
    savedOnPhone(true);
    api.myPinStatus.mockRejectedValue(MISSING_FUNCTION);
    await mount();
    await settle(60_000);
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("THE APP");
    expect(qc.getQueryData(["myPinStatus", USER])).toBe(true);
    expect(offline.forgetOfflinePin).not.toHaveBeenCalled();
  });

  it("with no saved answer the lock stays shut, says Forge couldn't check — not that you're offline — and Try again works", async () => {
    savedOnPhone();
    api.myPinStatus.mockRejectedValue(MISSING_FUNCTION);
    await mount();
    expect(text()).toContain("Forge couldn't check your PIN. Try again.");
    expect(text()).not.toContain("You're offline");
    expect(text()).not.toContain("THE APP");

    api.myPinStatus.mockResolvedValue(true);
    await act(async () => button("Try again").click());
    await settle();
    expect(text()).toContain("Enter your 4-digit PIN");
    expect(text()).not.toContain("THE APP");
  });

  it("says it in Spanish to a Spanish reader", async () => {
    localStorage.setItem("infinity.language", "es");
    savedOnPhone();
    api.myPinStatus.mockRejectedValue(MISSING_FUNCTION);
    await mount({ spanish: true });
    expect(text()).toContain("Forge no pudo revisar tu PIN. Inténtalo de nuevo.");
    expect(() => button("Intentar de nuevo")).not.toThrow();
  });
});

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
// plain words, with a Try again button, instead of spinning. The PIN itself is
// only ever checked by the server, so with no signal the lock stays shut and
// says why.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-4000-8000-0000000000a1";
const PROFILE = { id: USER, display_name: "Ana Lopez", role: "installer", language: "en" };
const HOURS_AGO = (h: number) => Date.now() - h * 60 * 60 * 1000;

// What a read looks like when the phone has no signal: postgrest-js hands the
// failure back as an error, and myPinStatus throws it (myPinStatus.test.ts).
const NO_SIGNAL = { message: "TypeError: Failed to fetch", code: "" };
const NEVER = () => new Promise<never>(() => {});

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

const { PinGate } = await import("./PinGate");
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
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

  it("unlocks on the right PIN and says so on a wrong one", async () => {
    api.myPinStatus.mockResolvedValue(true);
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "wrong" });
    api.checkMyPin.mockResolvedValueOnce({ ok: true });
    await mount();

    await typePin("1111");
    expect(text()).toContain("Wrong PIN — try again");
    expect(text()).not.toContain("THE APP");

    await typePin("4821");
    expect(api.checkMyPin).toHaveBeenLastCalledWith("4821");
    expect(text()).toContain("THE APP");
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

  it("(a) the PIN cannot be checked without signal, so the lock stays shut and says why", async () => {
    savedOnPhone(true);
    api.myPinStatus.mockRejectedValue(NO_SIGNAL);
    api.checkMyPin.mockResolvedValueOnce({ ok: false, reason: "network" });
    await mount();

    await typePin("4821");
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

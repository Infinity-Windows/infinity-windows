// @vitest-environment happy-dom
//
// Your own PIN is set on Settings (2026-09-25). It sat on the Roster, which has
// been supervisor-only since #610, so an installer or a foreman had no way to
// set, change or remove a PIN at all. What has to hold:
//   - an installer and a foreman both reach Settings: it is on their menu, and
//     the route guard lets them through;
//   - Settings shows them the PIN setting. The role comes in the way the app
//     gets it (the real profile, which useEffectiveRole reads), so a role
//     check added to the page later would fail this;
//   - it speaks Spanish;
//   - saving from Settings does what it did on the Roster: the server, the
//     offline unlock forgotten, the lock's answer written. PinGate.test.tsx
//     pins the rest of PinSetter's behaviour.
//
// The page's other cards (display mode, notifications, app updates, build
// identity) are stubbed: they have nothing to do with the PIN and each reads
// things of its own.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-4000-8000-0000000000a1";

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

vi.mock("../components/updates/AppUpdates", () => ({ AppUpdates: () => null }));
vi.mock("../components/DisplayModePicker", () => ({ DisplayModePicker: () => null }));
vi.mock("../components/BuildIdentityCard", () => ({ BuildIdentityCard: () => null }));
vi.mock("../components/permissions/PermissionsSettings", () => ({
  PermissionsSettings: () => null,
}));

const { Settings } = await import("./Settings");
const { LanguageProvider } = await import("../lib/i18n");
const { rememberSignedIn } = await import("../lib/signedIn");
const { canAccess, menuForRole } = await import("../lib/nav");

let container: HTMLElement;
let root: Root;
let qc: QueryClient;

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderSettingsAs(role: string, language: "en" | "es" = "en") {
  api.getRealProfile.mockResolvedValue({ id: USER, role, language, display_name: "Ana Lopez" });
  api.getMyProfile.mockResolvedValue({ id: USER, role, language, display_name: "Ana Lopez" });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <LanguageProvider>
          <MemoryRouter initialEntries={["/settings"]}>
            <Settings />
          </MemoryRouter>
        </LanguageProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The PIN card: the section whose heading names it. */
function pinCard(heading: string): HTMLElement | null {
  const h2 = [...container.querySelectorAll("h2")].find((h) => h.textContent === heading);
  return h2?.closest("section") ?? null;
}

function button(within: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...within.querySelectorAll("button")].find((b) => b.textContent === label);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("infinity.language", "en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.myPinStatus.mockResolvedValue(false);
  api.setMyPin.mockResolvedValue(undefined);
  rememberSignedIn({ user: { id: USER } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  rememberSignedIn(null);
  vi.clearAllMocks();
});

const ROLES = [
  ["an installer", "installer"],
  ["a foreman", "foreman"],
] as const;

describe("your own PIN, on Settings", () => {
  it.each(ROLES)("%s reaches Settings from the menu, and nothing stops them", (_who, role) => {
    const menuPaths = menuForRole(role).flatMap((s) => s.items.map((i) => i.to));
    expect(menuPaths).toContain("/settings");
    expect(canAccess(role, "/settings")).toBe(true);
  });

  it.each(ROLES)("%s sees the PIN setting on Settings", async (_who, role) => {
    await renderSettingsAs(role);

    const card = pinCard("PIN lock");
    expect(card, "the PIN lock card is on the page").not.toBeNull();
    expect(card!.textContent).toContain("With a PIN, Forge asks for it each time it opens.");
    const input = card!.querySelector("input")!;
    expect(input.placeholder).toBe("4 digits");
    // The label names the input, with whether a PIN is set.
    const label = card!.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
    expect(label?.textContent).toBe("Your quick-unlock PIN (none)");
    expect(button(card!, "Save PIN")).toBeDefined();
    // Nothing to remove yet.
    expect(button(card!, "Clear")).toBeUndefined();
  });

  it("speaks Spanish", async () => {
    localStorage.setItem("infinity.language", "es");
    api.myPinStatus.mockResolvedValue(true);
    await renderSettingsAs("installer", "es");

    const card = pinCard("Bloqueo con PIN");
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Con un PIN, Forge te lo pide cada vez que se abre.");
    const input = card!.querySelector("input")!;
    expect(input.placeholder).toBe("4 dígitos");
    expect(card!.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(
      "Tu PIN de desbloqueo rápido (configurado)",
    );
    expect(button(card!, "Guardar PIN")).toBeDefined();
    expect(button(card!, "Quitar PIN")).toBeDefined();
  });

  it("saving from Settings sets the PIN the way the Roster did", async () => {
    await renderSettingsAs("installer");
    const card = pinCard("PIN lock")!;
    const input = card.querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "4821");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    api.myPinStatus.mockResolvedValue(true);
    await act(async () => button(card, "Save PIN")!.click());
    await settle();

    expect(api.setMyPin).toHaveBeenCalledWith("4821");
    expect(offline.forgetOfflinePin).toHaveBeenCalled();
    expect(qc.getQueryData(["myPinStatus", USER])).toBe(true);
    expect(card.textContent).toContain("PIN saved.");
    expect(card.querySelector("label")?.textContent).toBe("Your quick-unlock PIN (set)");
  });
});

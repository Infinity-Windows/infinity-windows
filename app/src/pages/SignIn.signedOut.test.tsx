// @vitest-environment happy-dom
//
// The sign-in screen after the SERVER ended this phone's sign-in (2026-09-24):
// a login removed, a password changed, signed out everywhere. Without a line
// saying so, a crew member just finds themselves on the sign-in screen with no
// idea why — so it says so, in their language, until they try again. A
// sign-out they tapped, and a phone with no signal, never show it: the first
// is theirs, the second keeps them signed in (lib/offlineSession.ts).

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signInWithPassword = vi.fn(async () => ({ error: { message: "Invalid login credentials" } }));

vi.mock("../lib/supabase", () => ({
  supabase: { auth: { signInWithPassword, resetPasswordForEmail: vi.fn() } },
  supabaseConfigured: true,
}));
vi.mock("../lib/install/api", () => ({
  submitAccessRequest: vi.fn(),
  setMyLanguage: vi.fn(async () => {}),
}));

const { SignIn } = await import("./SignIn");

const EN = "You've been signed out on this phone";
const ES = "Se cerró tu sesión en este teléfono";

let root: Root;
let host: HTMLDivElement;

async function mount(props: Parameters<typeof SignIn>[0]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SignIn {...props} />));
}

beforeEach(() => {
  window.localStorage.clear();
  signInWithPassword.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("signed out by the server", () => {
  it("says so plainly", async () => {
    await mount({ signedOut: true });
    expect(host.textContent).toContain(EN);
    expect(host.textContent).toContain("ask your supervisor");
  });

  it("says so in Spanish on a phone set to Spanish", async () => {
    window.localStorage.setItem("infinity.language", "es");
    await mount({ signedOut: true });
    expect(host.textContent).toContain(ES);
    expect(host.textContent).not.toContain(EN);
  });

  it("says nothing of the kind otherwise", async () => {
    await mount({});
    expect(host.textContent).not.toContain(EN);
  });

  it("gives way to the answer once they try to sign in again", async () => {
    await mount({ signedOut: true });
    const signIn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Sign in");
    expect(signIn).toBeDefined();
    await act(async () => signIn!.click());
    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain(EN);
    expect(host.textContent).toContain("Invalid login credentials");
  });
});

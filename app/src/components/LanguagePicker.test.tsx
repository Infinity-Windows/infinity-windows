// @vitest-environment happy-dom
//
// The first-login picker, mounted for real, plus the context that feeds it.
// Two promises this slice makes, proven against the live DOM and the live
// provider rather than a helper in isolation:
//   1. Choosing a language WRITES it — through set_my_language, via setLang.
//   2. The active language resolves profile → localStorage → 'en'.
// A person who already has a choice on this device never sees the picker again.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider's only runtime dependencies: the profile read and the language
// write. Mocking the api module keeps the heavy install/api graph out of the
// test and lets us watch the exact call the picker makes.
const setMyLanguage = vi.fn().mockResolvedValue(undefined);
const getRealProfile = vi.fn().mockResolvedValue(null);
vi.mock("../lib/install/api", () => ({
  getRealProfile: (...a: unknown[]) => getRealProfile(...a),
  setMyLanguage: (...a: unknown[]) => setMyLanguage(...a),
}));
vi.mock("../lib/toast", () => ({ toastError: vi.fn() }));

const { LanguageProvider, useLanguage } = await import("../lib/i18n");
const { FirstRunLanguagePicker } = await import("./LanguagePicker");

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* happy-dom always has storage */
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderTree(node: React.ReactNode, seedProfile?: Record<string, unknown>) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
    },
  });
  // Seed the profile the way Heartbeat's test does — the read resolves from
  // cache synchronously, so the provider sees the loaded profile on first paint
  // rather than driving an async query lifecycle in a unit test.
  if (seedProfile) qc.setQueryData(["myRealProfile"], seedProfile);
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <LanguageProvider>{node}</LanguageProvider>
      </QueryClientProvider>,
    );
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!btn) throw new Error(`no button reading "${text}"`);
  return btn as HTMLButtonElement;
}

describe("FirstRunLanguagePicker", () => {
  it("shows for a person who has never chosen on this device", () => {
    renderTree(<FirstRunLanguagePicker />);
    expect(container.textContent).toContain("Choose your language");
    expect(container.textContent).toContain("English");
    expect(container.textContent).toContain("Español");
  });

  it("writes the language via set_my_language when Español is tapped", () => {
    renderTree(<FirstRunLanguagePicker />);
    act(() => {
      buttonByText("Español").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(setMyLanguage).toHaveBeenCalledWith("es");
    expect(localStorage.getItem("infinity.language")).toBe("es");
  });

  it("writes 'en' when English is tapped", () => {
    renderTree(<FirstRunLanguagePicker />);
    act(() => {
      buttonByText("English").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(setMyLanguage).toHaveBeenCalledWith("en");
    expect(localStorage.getItem("infinity.language")).toBe("en");
  });

  it("does NOT show once a choice exists on this device", () => {
    localStorage.setItem("infinity.language", "es");
    renderTree(<FirstRunLanguagePicker />);
    expect(container.textContent).toBe("");
  });

  it("dismisses itself after a choice is made", () => {
    renderTree(<FirstRunLanguagePicker />);
    expect(container.textContent).toContain("Choose your language");
    act(() => {
      buttonByText("Español").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(container.textContent).toBe("");
  });
});

describe("the language context resolves profile → localStorage → 'en'", () => {
  function LangProbe() {
    const { lang } = useLanguage();
    return <span data-testid="lang">{lang}</span>;
  }
  const currentLang = () =>
    container.querySelector('[data-testid="lang"]')?.textContent;

  it("defaults to English with no cache and no loaded profile", () => {
    renderTree(<LangProbe />);
    expect(currentLang()).toBe("en");
  });

  it("uses the localStorage cache before the profile has loaded", () => {
    localStorage.setItem("infinity.language", "es");
    renderTree(<LangProbe />);
    // The profile query has not resolved yet; the cache is what paints first.
    expect(currentLang()).toBe("es");
  });

  it("lets the loaded profile win over the cache", () => {
    localStorage.setItem("infinity.language", "es");
    renderTree(
      <LangProbe />,
      {
        id: "u1",
        display_name: "Ammon",
        skill_level: 3,
        role: "installer",
        active: true,
        language: "en",
      },
    );
    // The profile is already loaded (seeded), and its 'en' overrides the 'es'
    // cache — profile wins once it is known.
    expect(currentLang()).toBe("en");
  });

  it("uses the profile's Spanish when that is what is stored", () => {
    renderTree(
      <LangProbe />,
      {
        id: "u2",
        display_name: "Ana",
        skill_level: 2,
        role: "installer",
        active: true,
        language: "es",
      },
    );
    expect(currentLang()).toBe("es");
  });
});

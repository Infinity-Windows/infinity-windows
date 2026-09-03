// @vitest-environment happy-dom
//
// A newly-wrapped crew-flow component, mounted FOR REAL under the live language
// provider set to Spanish (tracking-jobs slice 7): the cost-code editor once
// hard-coded "Loading…", so this proves the whole path — provider → useT() →
// catalog — puts Spanish on the screen, not just that a helper resolves a key.
// The cost-code reads are held pending so the loading state (the string this
// slice wrapped) is what renders.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hold both cost-code reads pending forever, so the panel stays in its loading
// state and the wrapped "Cargando…" is on screen when we assert.
vi.mock("../../lib/timeclock", () => ({
  listCostCodes: () => new Promise(() => {}),
}));
vi.mock("../../lib/costCodes", () => ({
  listProjectCostCodes: () => new Promise(() => {}),
  setProjectCostCodes: vi.fn(),
}));
vi.mock("../../lib/toast", () => ({ pushToast: vi.fn(), toastError: vi.fn() }));
// The provider's own deps — the profile read is seeded via the query cache
// below, so this just keeps the heavy install/api graph out of the test.
vi.mock("../../lib/install/api", () => ({
  getRealProfile: vi.fn().mockResolvedValue(null),
  setMyLanguage: vi.fn().mockResolvedValue(undefined),
}));

const { LanguageProvider } = await import("../../lib/i18n");
const { JobCostCodesPanel } = await import("./JobCostCodesPanel");

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

function renderInSpanish() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
    },
  });
  // Seed the real profile as Spanish so the provider resolves lang="es" on the
  // first paint (same seeding LanguagePicker's own test relies on).
  qc.setQueryData(["myRealProfile"], {
    id: "u-es",
    display_name: "Ana",
    skill_level: 2,
    role: "foreman",
    active: true,
    language: "es",
  });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <LanguageProvider>
          <JobCostCodesPanel projectId="p1" />
        </LanguageProvider>
      </QueryClientProvider>,
    );
  });
}

describe("JobCostCodesPanel in Spanish", () => {
  it("renders its heading and loading state in Spanish, no English left", () => {
    renderInSpanish();
    const text = container.textContent ?? "";
    expect(text).toContain("Códigos de costo para este trabajo");
    expect(text).toContain("Cargando…");
    // The English the panel used to show must be gone.
    expect(text).not.toContain("Loading…");
    expect(text).not.toContain("Cost codes for this job");
  });
});

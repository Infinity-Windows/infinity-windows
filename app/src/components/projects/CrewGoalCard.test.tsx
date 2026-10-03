// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageContext, type LanguageContextValue } from "../../lib/i18n/context";
import { CATALOG, translate, type Lang } from "../../lib/i18n";
import type { CrewGoal } from "../../lib/crewGoal";
import { getCrewGoal } from "../../lib/crewGoal";
import { CrewGoalCard } from "./CrewGoalCard";

vi.mock("../../lib/crewGoal", () => ({ getCrewGoal: vi.fn() }));
vi.mock("../../lib/install/api", () => ({ getRealProfile: vi.fn() }));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let client: QueryClient | undefined;
const snapshot: CrewGoal = {
  goal_hours: 120, goal_revision: 2, goal_updated_at: "2026-10-01T12:00:00Z",
  recorded_hours: 72, running_provisional_hours: 2, open_shifts: 1,
  unresolved_shifts: 1, allowance_hours: 46, as_of: "2026-10-01T14:00:00Z",
};

afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  host?.remove();
  root = undefined; host = undefined; client = undefined;
  onlineManager.setOnline(true);
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  vi.resetAllMocks();
});

function mount(lang: Lang, online: boolean) {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
  onlineManager.setOnline(online);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["myRealProfile"], { id: "viewer" });
  client.setQueryData(["crewGoal", "viewer", "job"], snapshot, { updatedAt: 1 });
  const value: LanguageContextValue = {
    lang, t: (key, vars) => translate(CATALOG, lang, key, vars),
    setLang: () => {}, needsChoice: false,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<LanguageContext.Provider value={value}>
    <QueryClientProvider client={client!}><CrewGoalCard projectId="job" /></QueryClientProvider>
  </LanguageContext.Provider>));
  return host;
}

describe("crew goal saved access and freshness", () => {
  it.each(["en", "es"] as const)("labels offline hours as a saved snapshot in %s", (lang) => {
    const el = mount(lang, false);
    expect(el.textContent).toContain(lang === "en" ? "Saved snapshot from" : "Copia guardada del");
    expect(el.textContent).toContain("72.0 h");
    expect(el.textContent).toContain(lang === "en" ? "1 time records need review" : "1 registros de tiempo necesitan revisión");
    expect(getCrewGoal).not.toHaveBeenCalled();
  });

  it("removes cached hours when the server denies access after reconnecting", async () => {
    vi.mocked(getCrewGoal).mockRejectedValue({ code: "42501", message: "private server detail" });
    const el = mount("en", false);
    expect(el.textContent).toContain("72.0 h");
    await act(async () => {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
      onlineManager.setOnline(true);
      await client!.refetchQueries({ queryKey: ["crewGoal", "viewer", "job"] });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(getCrewGoal).toHaveBeenCalledWith("job");
    expect(el.textContent).toBe("");
  });
});

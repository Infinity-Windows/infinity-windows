// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { TripDetail } from "./TripDetail";
import type { TripDetail as Detail, Flight, Lodging } from "../lib/travel/types";
import { LanguageContext } from "../lib/i18n/context";
import { CATALOG } from "../lib/i18n/catalog";
import { translate, type Lang } from "../lib/i18n/translate";

const viewer = vi.hoisted(() => ({ effectiveRole: "installer" }));
vi.mock("../lib/useEffectiveRole", () => ({ useEffectiveRole: () => viewer }));

function renderTrip(status: "draft" | "published", role = "installer", lang: Lang = "en") {
  viewer.effectiveRole = role;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const detail: Detail = {
    trip: {
      id: "trip", name: "Crew trip", destination: "Fixture job", project_id: null,
      start_date: "2026-01-01", end_date: "2099-12-31", timezone: "America/Denver",
      notes: "Meet at the shop.", status, published_at: null, created_by: null,
      created_at: "2026-01-01", updated_at: "2026-01-01",
      crew: [{ profile_id: "me", role: "crew", display_name: "Fixture crew" }],
    },
    flights: [
      { id: "my-flight", trip_id: "trip", profile_id: "me", airline: "My airline", sort_order: 0 },
      { id: "other-flight", trip_id: "trip", profile_id: "other", airline: "Private airline", sort_order: 1 },
    ] as Flight[],
    lodging: [{ id: "house", trip_id: "trip", name: "Crew house", entry_steps: "Use side entrance", door_code: "54321", sort_order: 0 }] as Lodging[],
    ground: [], procedures: [], contacts: [{ id: "host", trip_id: "trip", name: "Fixture host", label: "Host", phone: "8015550123", notes: null, sort_order: 0 }],
    attachments: [],
  };
  client.setQueryData(["workflowLinks"], { available: false, assignments: [], trips: [] });
  client.setQueryData(["myProfile"], { id: "me" });
  client.setQueryData(["trip", "trip"], detail);
  const html = renderToStaticMarkup(
    <LanguageContext.Provider value={{ lang, t: (key, vars) => translate(CATALOG, lang, key, vars), setLang: () => {}, needsChoice: false }}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/travel/trip"]}>
          <Routes><Route path="/travel/:tripId" element={<TripDetail />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </LanguageContext.Provider>,
  );
  const dom = document.createElement("div");
  dom.innerHTML = html;
  client.clear();
  return dom;
}

describe("continuous trip sheet", () => {
  it("shows every section together and links to real focusable destinations", () => {
    const dom = renderTrip("published");
    for (const link of dom.querySelectorAll<HTMLAnchorElement>(".travel-jumps a")) {
      const target = dom.querySelector(link.getAttribute("href")!);
      expect(target).not.toBeNull();
      expect(target?.getAttribute("tabindex")).toBe("-1");
    }
    expect(dom.querySelectorAll(".travel-sheet-section")).toHaveLength(6);
    expect(dom.querySelector('[role="tab"]')).toBeNull();
    expect(dom.textContent).toContain("Crew house");
    expect(dom.textContent).toContain("Use side entrance");
    expect(dom.textContent).toContain("Fixture host");
  });
  it("keeps crew flight privacy and management controls scoped", () => {
    const crew = renderTrip("published");
    expect(crew.textContent).toContain("My airline");
    expect(crew.textContent).not.toContain("Private airline");
    expect(crew.querySelector("#trip-publish")).toBeNull();
    expect(crew.querySelector('[aria-label="Edit lodging"]')).toBeNull();
    const manager = renderTrip("draft", "supervisor");
    expect(manager.textContent).toContain("Private airline");
    expect(manager.querySelector("#trip-publish button")).not.toBeNull();
    expect(manager.querySelector("#trip-publish")?.previousElementSibling?.id).toBe("trip-files");
  });
  it("does not expose an unpublished trip to assigned crew", () => {
    const dom = renderTrip("draft");
    expect(dom.querySelector(".travel-jumps")).toBeNull();
    expect(dom.textContent).not.toContain("Crew house");
    expect(dom.textContent).not.toContain("54321");
  });
  it("renders jump navigation in Spanish", () => {
    const dom = renderTrip("published", "installer", "es");
    expect(dom.querySelector(".travel-jumps")?.getAttribute("aria-label")).toBe("Secciones del viaje");
    expect(dom.querySelector('a[href="#trip-lodging"]')?.textContent).toBe("Hospedaje");
  });
});

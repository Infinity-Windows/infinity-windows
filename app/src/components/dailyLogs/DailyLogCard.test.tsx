// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LanguageContext, type LanguageContextValue } from "../../lib/i18n/context";
import { CATALOG, translate } from "../../lib/i18n";
import { emptyProgressFields } from "../../lib/dailyLogStages";
import type { DailyLog } from "../../lib/dailyLogs";

const m = vi.hoisted(() => ({ photos: vi.fn() }));
vi.mock("../../lib/photos", () => ({ listDailyLogPhotos: m.photos }));

import { DailyLogCard } from "./DailyLogCard";

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const lang: LanguageContextValue = { lang: "en", t: ((k: string, vars?: Record<string, string|number>) => translate(CATALOG, "en", k as keyof typeof CATALOG, vars)) as LanguageContextValue["t"], setLang: () => {}, needsChoice: false };

function log(over: Partial<DailyLog> = {}): DailyLog {
  return {
    id: "log-1", project_id: "job-1", log_date: "2026-10-01", headline: null, notes: "",
    day_flow: null, reflection: null, weather: null, customer_visible: false, customer_visible_at: null,
    revision: 1, filed_by: "ana", updated_by: null, created_at: "2026-10-01T18:00:00Z", updated_at: "2026-10-01T18:00:00Z",
    filer: { display_name: "Ana" }, project: { job_code: "BLACK22", name: "Black Desert" }, job_name: null,
    ...emptyProgressFields(),
    ...over,
  } as DailyLog;
}

async function mount(props: Partial<React.ComponentProps<typeof DailyLogCard>> = {}) {
  const defaults: React.ComponentProps<typeof DailyLogCard> = {
    log: log(), jobLabel: "BLACK22 · Black Desert", earlierSameJobLogs: [], isLatest: true,
    onOpen: () => {}, onEdit: () => {},
  };
  await act(async () => root.render(
    <LanguageContext.Provider value={lang}><QueryClientProvider client={client}>
      <ul><DailyLogCard {...defaults} {...props} /></ul>
    </QueryClientProvider></LanguageContext.Provider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

beforeEach(() => {
  m.photos.mockReset();
  m.photos.mockResolvedValue([]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); });

it("shows completed today, to date, and remaining together", async () => {
  await mount({ log: log({ unitsToday: 3, unitsToDate: 12, unitsRemaining: 2 }) });
  expect(host.textContent).toContain("Completed today");
  expect(host.textContent).toContain("Completed to date");
  expect(host.textContent).toContain("Remaining");
  expect(host.textContent).toContain("3");
  expect(host.textContent).toContain("12");
});

it("labels the latest card Latest, and any other card just Reported as of", async () => {
  await mount({ log: log({ log_date: "2026-10-01" }), isLatest: true });
  expect(host.textContent).toContain("Latest in this range, as of");
  await mount({ log: log({ log_date: "2026-09-28" }), isLatest: false });
  expect(host.textContent).not.toContain("Latest in this range, as of");
  expect(host.textContent).toContain("Reported as of");
});

it("a selected stage with no reported value reads Not reported, never 0%", async () => {
  await mount({ log: log({ workStages: ["frames"], stageProgress: {} }) });
  expect(host.textContent).toContain("Not reported");
  expect(host.querySelector(".daily-log-progress-bar-mini")).toBeNull();
});

it("a reported stage value still renders its bar and percent", async () => {
  await mount({ log: log({ workStages: ["frames"], stageProgress: { frames: 40 } }) });
  expect(host.textContent).toContain("40%");
  expect(host.querySelector(".daily-log-progress-bar-mini")).not.toBeNull();
});

it("never shows a fabricated Sun when no weather impact was recorded", async () => {
  await mount({ log: log({ workStages: ["frames"], stageProgress: { frames: 10 }, weatherImpact: null }) });
  expect(host.querySelector(".lucide-sun")).toBeNull();
});

it("shows Sun only for an explicitly recorded none-impact day", async () => {
  await mount({ log: log({ workStages: ["frames"], stageProgress: { frames: 10 }, weatherImpact: "none" }) });
  expect(host.querySelector(".lucide-sun")).not.toBeNull();
});

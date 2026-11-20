// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { DataComparison } from "./DataComparison";
const reads = vi.hoisted(() => ({ history: vi.fn(async () => []) }));
vi.mock("../../lib/i18n", () => ({ useLanguage: () => ({ lang: "en" }) }));
vi.mock("../../lib/signedIn", () => ({ signInMark: () => ({ userId: "owner", generation: 1 }) }));
vi.mock("../../lib/api", () => ({ listProjectsAnyStatus: vi.fn(async () => []) }));
vi.mock("../../lib/timeclock", () => ({ listTeamShifts: vi.fn(async () => []) }));
vi.mock("../DataHub", async () => {
  const { useState } = await import("react");
  const { useQuery } = await import("@tanstack/react-query");
  const { reportProjects, reportShifts } = await import("./reportQueries");
  return { DataHub: ({ active }: { active: boolean }) => {
    const [value, setValue] = useState(0);
    useQuery(reportProjects("owner:1", active));
    useQuery(reportShifts("owner:1", ["job"], 0, 1000, active));
    return <button onClick={() => setValue(value + 1)}>Current filter {value}</button>;
  } };
});
vi.mock("./ActivityExplorer", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  const { reportProjects, reportShifts, reportQueryPolicy } = await import("./reportQueries");
  return { ActivityExplorer: ({ active }: { active: boolean }) => {
    useQuery(reportProjects("owner:1", active));
    useQuery(reportShifts("owner:1", ["job"], 0, 1000, active));
    useQuery({ ...reportQueryPolicy, queryKey: ["dataReview", "owner:1", "historical"], queryFn: reads.history, enabled: active });
    return <p>Proposed chart fixture</p>;
  } };
});
import { listTeamShifts } from "../../lib/timeclock";
import { listProjectsAnyStatus } from "../../lib/api";

it("keeps comparison controls while pausing inactive work, shares caches, without a manual-refresh banner", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = new QueryClient();
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
  const click = async (text: string) => { const button = [...host.querySelectorAll("button")].find(node => node.textContent === text)!; expect(button).toBeTruthy(); await act(async () => button.click()); await settle(); };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><DataComparison /></QueryClientProvider>));
    await settle();
    expect([...host.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(["Job Performance", "Work Dashboard"]);
    await click("Current filter 0");
    await click("Work Dashboard");
    expect(listTeamShifts).toHaveBeenCalledTimes(1);
    expect(listProjectsAnyStatus).toHaveBeenCalledTimes(1);
    expect(reads.history).toHaveBeenCalledTimes(1);
    focusManager.setFocused(false); focusManager.setFocused(true); await settle();
    expect(listTeamShifts).toHaveBeenCalledTimes(1);
    await click("Job Performance");
    expect(host.textContent).toContain("Current filter 1");
    expect(host.textContent).not.toContain("Refresh report");
    await act(async () => { await client.invalidateQueries({ queryKey: ["dataReview", "owner:1"] }); });
    expect(listTeamShifts).toHaveBeenCalledTimes(2);
    expect(listProjectsAnyStatus).toHaveBeenCalledTimes(2);
    expect(reads.history).toHaveBeenCalledTimes(1);
    await click("Work Dashboard");
    expect(reads.history).toHaveBeenCalledTimes(2);
    expect(listTeamShifts).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); client.clear(); host.remove(); focusManager.setFocused(undefined); }
});

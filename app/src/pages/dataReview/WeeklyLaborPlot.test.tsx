// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WeeklyLaborPlot } from "./WeeklyLaborPlot";
import { midnight } from "./generalLabor";

it("labels days once per job pair and drills into one Denver day across DST", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); const inspect = vi.fn();
  const buckets = ["A", "B"].map(job => ({ key: "2026-03-08", seriesKey: job, seriesLabel: job, seconds: 3600, totalSeconds: 3600, percent: 100, partial: false, ids: [job], segments: [{ activity: "Install", seconds: 3600, ids: [job] }] }));
  try {
    await act(async () => root.render(<WeeklyLaborPlot period="day" buckets={buckets} metric="hours" color={() => "orange"} from={midnight("2026-03-08")} until={midnight("2026-03-10")} onInspect={inspect} />));
    expect([...host.querySelectorAll('.weekly-group-label')].map(label => label.textContent)).toEqual(["Sun, Mar 8"]);
    await act(async () => host.querySelector<HTMLButtonElement>('.general-week-segment')!.click());
    expect(inspect.mock.calls[0]).toEqual([["A"], [midnight("2026-03-08"), midnight("2026-03-09")]]);
    expect((inspect.mock.calls[0][1][1] - inspect.mock.calls[0][1][0]) / 3600000).toBe(23);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("keeps job-week percentages and shift drill-down distinct on a shared time axis", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), inspect = vi.fn();
  const bars = ["A", "B"].map(job => ({ key: "2026-10-05", seriesKey: job, seriesLabel: job, seconds: 3600, totalSeconds: 14400, percent: 25, partial: false, ids: [job], segments: [{ activity: "Install", seconds: 3600, ids: [job] }] }));
  try {
    await act(async () => root.render(<WeeklyLaborPlot buckets={bars} metric="percent" color={() => "orange"} from={-Infinity} until={Infinity} onInspect={inspect} />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".general-week-segment")];
    expect(buttons[0].getAttribute("aria-label")).toContain("2026-10-05 · A, Install: 60.0 min · 25.0%");
    expect(buttons[1].style.height).toBe("25%");
    await act(async () => buttons[1].click());
    expect(inspect.mock.calls[0][0]).toEqual(["B"]);
    expect(host.querySelectorAll(".weekly-column")).toHaveLength(2);
    expect(host.querySelectorAll('.weekly-group[role="group"]')).toHaveLength(1);
    expect([...host.querySelectorAll('.weekly-group-label > span')].map(label => label.textContent)).toEqual(["Oct 5"]);
    expect(host.querySelectorAll('.weekly-x-label span')).toHaveLength(0);
    await act(async () => root.render(<WeeklyLaborPlot buckets={bars.map((bar, index) => ({ ...bar, key: index ? "2026-10-12" : bar.key, groupKey: "relative:0", groupLabel: "Week 1" }))} metric="percent" color={() => "orange"} from={-Infinity} until={Infinity} onInspect={inspect} />));
    expect(host.querySelectorAll('.weekly-group[role="group"]')).toHaveLength(1);
    expect([...host.querySelectorAll('.weekly-group-label > span')].map(label => label.textContent)).toEqual(["Week 1"]);
    expect([...host.querySelectorAll('.weekly-x-label small')].map(label => label.textContent)).toEqual(["Oct 5", "Oct 12"]);
    await act(async () => host.querySelectorAll<HTMLButtonElement>(".general-week-segment")[1].click());
    expect(inspect.mock.calls[1][1][0]).toBe(Date.parse("2026-10-12T06:00:00Z"));
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("starts at the latest end, preserves earlier inspection on data refresh and resets for a new range", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const width = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1200);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const buckets = [{ key: "2026-10-05", seconds: 3600, totalSeconds: 3600, percent: 100, partial: false, ids: ["a"], segments: [{ activity: "Install", seconds: 3600, ids: ["a"] }] }];
  const render = (from: number, metric = "hours", seconds = 3600) => root.render(<WeeklyLaborPlot buckets={buckets.map(bucket => ({ ...bucket, seconds }))} metric={metric} color={() => "orange"} from={from} until={Infinity} onInspect={() => {}} />);
  try {
    await act(async () => render(0));
    const viewport = host.querySelector<HTMLDivElement>(".weekly-scroll")!;
    expect(viewport.scrollLeft).toBe(1200);
    expect(host.textContent).toContain("Earlier weeks");
    viewport.scrollLeft = 100;
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    await act(async () => render(0, "percent", 7200));
    expect(viewport.scrollLeft).toBe(100);
    await act(async () => render(1));
    expect(viewport.scrollLeft).toBe(1200);
  } finally { await act(async () => root.unmount()); host.remove(); width.mockRestore(); }
});

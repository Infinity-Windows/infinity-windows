// @vitest-environment happy-dom
//
// The Heartbeat's Live crew list, read the way a supervisor reads it.
//
// `liveCrewHref` on its own proves nothing a person can see. A unit test of
// the string would stay green with the rows reverted to plain `<li>` markup
// and the helper called by nobody — which is exactly how a screen quietly
// stops being clickable. So this mounts the real page, seeds only what the
// server would have returned, and reads the real DOM: if a Live crew row
// stops being a link to that unit, these fail.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatSnapshot, HeartbeatTask } from "../lib/heartbeat";
import { liveCrewHref } from "../lib/heartbeat";
import { Heartbeat } from "./Heartbeat";

// The page opens a realtime firehose across every job's openings. That is a
// live WebSocket to the server and has nothing to do with what a row says, so
// it is held still — everything else on the page is the real thing.
vi.mock("../lib/useRealtimeOpenings", () => ({
  useRealtimeAllOpenings: () => {},
  useRealtimeOpenings: () => {},
}));

function task(over: Partial<HeartbeatTask> = {}): HeartbeatTask {
  return {
    openingId: "o1",
    projectId: "p1",
    installerName: "Ammon",
    openingLabel: "Unit 12-2 living",
    elapsedSec: 20 * 60,
    medianSec: 30 * 60,
    anomaly: false,
    stale: false,
    ...over,
  };
}

function snapshot(tasks: HeartbeatTask[]): HeartbeatSnapshot {
  return {
    projects: [
      {
        id: "p1",
        name: "Black Desert",
        jobCode: "BLACK22",
        pct: 40,
        installed: 4,
        total: 10,
        greenLight: true,
        greenLightNote: null,
        openIssues: 0,
        activeTasks: tasks,
      },
    ],
    generatedAt: new Date().toISOString(),
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Mount the real page and return its live DOM node. */
function mount(tasks: HeartbeatTask[]): HTMLElement {
  // Seeded rows count as fresh, so nothing goes back to the server behind the
  // test's back. What is seeded below is the whole world this page can see.
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  // A supervisor: the role this page lands on at "/". Not an owner, so the
  // owner-only log-coverage line stays off and this stays about the rows.
  qc.setQueryData(["myRealProfile"], { id: "me", role: "supervisor" });
  qc.setQueryData(["jobsNeedingLog"], []);
  qc.setQueryData(["heartbeat"], snapshot(tasks));
  // The ClockInBlock now rides the top of this landing (standard-tracking-jobs
  // slice 1). Seed what it reads so it renders its off-the-clock state without
  // reaching for the server behind the test's back.
  qc.setQueryData(["myProfile"], { id: "me", role: "supervisor" });
  qc.setQueryData(["openShift", "me"], null);
  qc.setQueryData(["costCodes"], []);
  qc.setQueryData(["recentJobs", "me"], []);
  qc.setQueryData(["projects"], []);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/heartbeat"]}>
          <Heartbeat />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}

/** Every Live crew row's own link, in the order the page sorted them. */
function liveCrewRowLinks(el: HTMLElement): HTMLAnchorElement[] {
  return [...el.querySelectorAll<HTMLAnchorElement>("ul.work-list li a")];
}

describe("the Live crew list", () => {
  it("makes each row a link to that unit's opening sheet", () => {
    const t = task();
    const el = mount([t]);
    const links = liveCrewRowLinks(el);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/projects/p1/opening/o1");
    // And the page really builds that from the task rather than from a path
    // typed twice — the row and the helper have to agree.
    expect(links[0].getAttribute("href")).toBe(liveCrewHref(t));
  });

  it("keeps the whole row inside the link, not just a corner of it", () => {
    // A supervisor reading "Ammon · BLACK22 · Unit 12-2 living" taps the words
    // they are reading. If only a trailing chevron were the link, the tap that
    // a thumb actually makes would do nothing.
    const el = mount([task()]);
    const [link] = liveCrewRowLinks(el);
    expect(link.textContent).toContain("Ammon");
    expect(link.textContent).toContain("BLACK22");
    expect(link.textContent).toContain("Unit 12-2 living");
  });

  it("opens the unit from a never-finished row too", () => {
    // This is the row the whole change is for: the stamp nobody closed is
    // flagged here, and it gets resolved on the unit's own sheet, so the row
    // that raises it has to be the row that opens it.
    const t = task({ openingId: "o9", stale: true, elapsedSec: 4 * 24 * 3600 });
    const el = mount([t]);
    const [link] = liveCrewRowLinks(el);
    expect(link.textContent).toContain("NEVER FINISHED");
    expect(link.getAttribute("href")).toBe("/projects/p1/opening/o9");
  });

  it("gives every row its own link when several people are mid-install", () => {
    const el = mount([
      task({ openingId: "o1", installerName: "Ammon" }),
      task({ openingId: "o2", installerName: "Ben" }),
      task({ openingId: "o3", installerName: "Cody" }),
    ]);
    const hrefs = liveCrewRowLinks(el).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "/projects/p1/opening/o1",
      "/projects/p1/opening/o2",
      "/projects/p1/opening/o3",
    ]);
  });

  it("says nothing to open when nobody is mid-install", () => {
    const el = mount([]);
    expect(liveCrewRowLinks(el)).toHaveLength(0);
    expect(el.textContent).toContain("Nobody's mid-install right now.");
  });
});

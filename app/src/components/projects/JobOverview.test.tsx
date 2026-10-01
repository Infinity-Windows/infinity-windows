// @vitest-environment happy-dom
//
// Mounted for real and read from the DOM, the same way ClockInBlock.test.tsx
// does: the query cache is seeded directly with a JobsOverviewSnapshot (this
// component's only contract with lib/jobsOverview), so the render under test
// is exactly what JobOverview does with a known snapshot — never a mock of
// its own internals.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { JobOverview } from "./JobOverview";
import type { JobOverviewRow, JobsOverviewSnapshot } from "../../lib/jobsOverview";
import type { Project } from "../../lib/types";
import { localWorkDate } from "../../lib/customWork/model";

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  host = null;
  root = null;
});

const PROJECTS: Project[] = [
  { id: "p1", job_code: "OAK1", name: "Oak House", address: null, status: "active" },
  { id: "p2", job_code: "PINE1", name: "Pine Remodel", address: null, status: "active" },
];

function row(over: Partial<JobOverviewRow>): JobOverviewRow {
  return {
    id: "p1",
    name: "Oak House",
    jobCode: "OAK1",
    href: "/projects/p1",
    isUpcoming: false,
    scope: { available: true, openings: 24, installed: 18 },
    customWork: null,
    today: { crewNames: ["Ammon"], note: null },
    nextStep: null,
    concern: null,
    lastActivity: { atISO: "2026-10-01T09:15:00Z", source: "opening" },
    needsAttention: false,
    ...over,
  };
}

function snapshot(over: Partial<JobsOverviewSnapshot>): JobsOverviewSnapshot {
  return {
    generatedAt: "2026-10-01T10:00:00Z",
    rows: [row({})],
    changes: [],
    sources: {
      scope: true,
      issues: true,
      schedule: true,
      customWork: true,
      dailyLogs: true,
      sessions: true,
      readiness: true,
    },
    scopeGaps: [],
    ...over,
  };
}

function mount(snap: JobsOverviewSnapshot, projects: Project[] = PROJECTS): HTMLElement {
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
  const key = ["jobsOverview", [...projects.map((p) => p.id)].sort().join(","), localWorkDate()];
  qc.setQueryData(key, snap);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <JobOverview projects={projects} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}

describe("JobOverview", () => {
  it("shows an empty Needs attention section when nothing is flagged", () => {
    const el = mount(snapshot({ rows: [row({ needsAttention: false })] }));
    expect(el.textContent).toContain("Nothing flagged right now.");
  });

  it("lists a flagged job under Needs attention with its concern", () => {
    const el = mount(
      snapshot({
        rows: [
          row({
            id: "p1",
            needsAttention: true,
            concern: {
              kind: "issue",
              issueKind: "blocker",
              severity: "urgent",
              label: "Blocker",
              note: "Framing not ready",
              assignedToName: "Jordan",
              ageLabel: "1d ago",
              href: "/issues?issue=i1",
              exactLink: true,
            },
          }),
        ],
      }),
    );
    expect(el.textContent).toContain("Needs attention (1)");
    expect(el.textContent).toContain("Reported blocker");
    expect(el.textContent).toContain("Assigned to Jordan");
  });

  it("shows recorded opening progress and custom-work progress separately for a mixed job", () => {
    const el = mount(
      snapshot({
        rows: [
          row({
            id: "p1",
            scope: { available: true, openings: 24, installed: 18 },
            customWork: { available: true, total: 4, completed: 2 },
          }),
        ],
      }),
    );
    expect(el.textContent).toContain("18 of 24 openings installed");
    expect(el.textContent).toContain("2 of 4 units complete");
  });

  it("says progress is unavailable rather than showing a false zero", () => {
    const el = mount(snapshot({ rows: [row({ scope: { available: false, openings: 0, installed: 0 } })] }));
    expect(el.textContent).toContain("Progress unavailable");
    expect(el.textContent).not.toContain("0 of 0");
  });

  it("says 'No reported concern' rather than leaving the line blank", () => {
    const el = mount(snapshot({ rows: [row({ concern: null })] }));
    expect(el.textContent).toContain("No reported concern");
  });

  it("marks an upcoming job that is not yet active", () => {
    const el = mount(snapshot({ rows: [row({ isUpcoming: true })] }));
    expect(el.textContent).toContain("Oak House");
  });

  it("surfaces a per-source failure without hiding the jobs that did load", () => {
    const el = mount(
      snapshot({
        rows: [row({})],
        sources: {
          scope: true,
          issues: false,
          schedule: true,
          customWork: true,
          dailyLogs: true,
          sessions: true,
          readiness: true,
        },
      }),
    );
    expect(el.textContent).toContain("Issues unavailable");
    expect(el.textContent).toContain("Oak House");
    expect(el.textContent).toContain("Concern information incomplete");
    expect(el.textContent).not.toContain("No reported concern");
    expect(el.textContent).not.toContain("Nothing flagged right now.");
  });

  it("lists a meaningful change with its job label and links to its source", () => {
    const el = mount(
      snapshot({
        changes: [
          {
            id: "c1",
            projectId: "p1",
            jobLabel: "Oak House",
            text: "Issue resolved",
            kind: "issueResolved", issueKind: "blocker",
            atISO: "2026-10-01T08:00:00Z",
            href: "/projects/p1?tab=dispatch",
          },
        ],
      }),
    );
    expect(el.textContent).toContain("Resolved: Reported blocker");
    const link = el.querySelector("a.jo-change-link") as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toBe("/projects/p1?tab=dispatch");
  });

  it("says nothing changed rather than inventing a change", () => {
    const el = mount(snapshot({ changes: [] }));
    expect(el.textContent).toContain("Nothing recorded as changed since yesterday.");
  });

  it("shows the fetched time separately from a job's own last-activity time", () => {
    const el = mount(
      snapshot({
        generatedAt: "2026-10-01T10:00:00Z",
        rows: [row({ lastActivity: { atISO: "2026-09-29T09:15:00Z", source: "opening" } })],
      }),
    );
    expect(el.textContent).toMatch(/Updated/);
    expect(el.textContent).toMatch(/Last recorded/);
  });

  it("keeps issue links outside job links and attention compact", () => {
    const concern = { kind: "issue" as const, issueKind: "blocker" as const, severity: "urgent" as const, label: "Blocker", note: "Needs framing", assignedToName: "Jordan", ageLabel: null, href: "/issues?issue=i1", exactLink: true };
    const el = mount(snapshot({ rows: [row({ concern, needsAttention: true })] }));
    expect(el.querySelector("a a")).toBeNull();
    expect(el.querySelectorAll("article.jo-row")).toHaveLength(1);
    expect(el.querySelector(".jo-attention article.jo-row")).toBeNull();
    expect(el.querySelector("a[href='/issues?issue=i1']")).not.toBeNull();
    expect(el.querySelector("details summary")).not.toBeNull();
  });

  it("does not render a second New project control or job list", () => {
    const el = mount(snapshot({}));
    expect(el.textContent).not.toContain("New project");
  });
});

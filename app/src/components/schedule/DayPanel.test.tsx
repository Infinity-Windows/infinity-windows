// Wave C, C3: canSeeHours is the ONE role-gating switch DayPanel owns —
// Foreman+ sees per-person hours and the Logs tab-through, installers see
// names only. Pinned directly here (static markup, no router-guard/auth
// stack) because /scheduling's own route guard (minRole "foreman",
// lib/nav.ts) makes the installer side of this unreachable by any e2e
// flow, preview included — RequireRole gates on the effective (preview-
// aware) role too, so even a supervisor previewing as installer is bounced
// before ever reaching the panel. See calendar-memory.spec.ts's header
// comment for the fuller story.
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DayPanel } from "./DayPanel";
import type { DayMemory } from "../../lib/schedule/dayMemory";

const WITH_LOG: DayMemory = {
  date: "2026-08-24",
  jobs: [
    {
      projectId: "j-1",
      jobCode: "BLACK22",
      jobName: "Black Desert",
      assigned: ["Ammon", "Jess"],
      worked: [{ profileId: "p-ammon", name: "Ammon", hours: 8 }],
      unitsFinished: 1,
      log: { headline: "Good day", day_flow: "smooth", notes: "All good." },
    },
  ],
  deliveries: [],
};

const NO_LOG: DayMemory = {
  date: "2026-08-24",
  jobs: [
    {
      projectId: "j-1",
      jobCode: "BLACK22",
      jobName: "Black Desert",
      assigned: ["Ammon"],
      worked: [],
      unitsFinished: 0,
      log: null,
    },
  ],
  deliveries: [],
};

function markup(memory: DayMemory | null, canSeeHours: boolean, loading = false): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DayPanel
        date="2026-08-24"
        memory={memory}
        loading={loading}
        canSeeHours={canSeeHours}
        assignmentFor={() => null}
        onEditAssignment={() => {}}
        onScheduleCrew={() => {}}
        onClose={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("DayPanel", () => {
  it("foreman+: shows per-person hours and the Logs tab-through", () => {
    const html = markup(WITH_LOG, true);
    expect(html).toContain("Ammon — 8h");
    expect(html).toContain("Open the Logs tab");
  });

  it("below foreman: names only — no hours, no Logs tab-through", () => {
    const html = markup(WITH_LOG, false);
    expect(html).toContain(">Ammon<");
    expect(html).not.toContain("Ammon — 8h");
    expect(html).not.toContain("Open the Logs tab");
  });

  it("renders the filed log's day-flow, headline and notes", () => {
    const html = markup(WITH_LOG, true);
    expect(html).toContain("Smooth");
    expect(html).toContain("Good day");
    expect(html).toContain("All good.");
  });

  it("falls back to the assigned-but-nobody-punched line when there's no log", () => {
    const html = markup(NO_LOG, true);
    expect(html).toContain("Assigned, but no crew punched in.");
  });

  it("says 'Nobody punched in' under Worked when nobody has, alongside the fallback line", () => {
    const html = markup(NO_LOG, true);
    expect(html).toContain("Nobody punched in");
  });

  it("says 'No day record.' when nothing touched the day at all", () => {
    const html = markup({ date: "2026-08-24", jobs: [], deliveries: [] }, true);
    expect(html).toContain("No day record.");
  });

  it("shows a loading line instead of the record while still fetching", () => {
    const html = markup(null, true, true);
    expect(html).toContain("Pulling up that day");
    expect(html).not.toContain("No day record.");
  });
});

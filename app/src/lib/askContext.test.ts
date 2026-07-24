import { describe, expect, it } from "vitest";
import {
  ASK_SYSTEM_PROMPT,
  buildContextBlock,
} from "../../../supabase/functions/_shared/knowledge";
import { appGuideForRole, renderAppGuide } from "../../../supabase/functions/_shared/appGuide";

// Covers the role-scoped LIVE-context additions rendered by buildContextBlock:
// the app guide, the user's assigned windows/doors + warehouse location, the
// widened inventory (by-slot + staged-for-job), the crew schedule, and the
// management-only financials — plus the hardened, access-aware system prompt.

describe("buildContextBlock — role-aware app guide section", () => {
  it("labels the guide with the user's role and lists its tabs", () => {
    const block = buildContextBlock([], {
      role: "installer",
      appGuide: renderAppGuide(appGuideForRole("installer")),
    });
    expect(block).toContain("App guide");
    expect(block).toContain("for a installer");
    expect(block).toContain("Home (/):");
    expect(block).toContain("Ask (/ask):");
  });

  it("omits the guide section entirely when absent", () => {
    expect(buildContextBlock([], {})).not.toContain("App guide");
  });
});

describe("buildContextBlock — assigned windows/doors + warehouse location", () => {
  it("renders the kind, opening, job, status, unit and its slot address", () => {
    const block = buildContextBlock([], {
      assignments: [
        {
          kind: "window",
          code: "W3",
          label: "Kitchen north",
          status: "assigned",
          job: "J12 Maple St",
          unit: "W-CAS3050-0042",
          location: "S-03-B",
        },
        {
          kind: "door",
          code: "D1",
          label: "Front entry",
          status: "assigned",
          job: "J12 Maple St",
          unit: "W-DR3680-0007",
          location: "on the truck",
        },
      ],
    });
    expect(block).toContain("Your assigned windows/doors");
    expect(block).toContain("W3 (Kitchen north) window on J12 Maple St [assigned] unit W-CAS3050-0042 @ S-03-B");
    expect(block).toContain("D1 (Front entry) door on J12 Maple St [assigned] unit W-DR3680-0007 @ on the truck");
  });

  it("omits the block when there are no assignments", () => {
    expect(buildContextBlock([], { assignments: [] })).not.toContain(
      "Your assigned windows/doors",
    );
  });
});

describe("buildContextBlock — widened inventory (slots + staged)", () => {
  it("renders stock by warehouse slot and units staged per job", () => {
    const block = buildContextBlock([], {
      inventory: {
        onHand: 120,
        byLocation: [
          { address: "S-03-B", zone: "S", count: 6 },
          { address: "S-01-A", zone: "S", count: 4 },
        ],
        stagedForJobs: [{ job: "J12 Maple St", count: 8 }],
      },
    });
    expect(block).toContain("stock by warehouse slot: S-03-B×6; S-01-A×4");
    expect(block).toContain("staged for jobs: J12 Maple St×8");
  });
});

describe("buildContextBlock — crew schedule (foreman+)", () => {
  it("renders who's scheduled where with crew names", () => {
    const block = buildContextBlock([], {
      crewSchedule: [
        {
          job: "J12 Maple St",
          start_date: "2026-07-24",
          end_date: "2026-07-25",
          start_time: "06:30:00",
          crew: ["Ana", "Cody"],
        },
      ],
    });
    expect(block).toContain("Crew schedule (who's scheduled where)");
    expect(block).toContain("J12 Maple St (2026-07-24→2026-07-25 06:30:00) — Ana, Cody");
  });

  it("omits the block when the crew schedule is empty (e.g. an installer)", () => {
    expect(buildContextBlock([], { crewSchedule: [] })).not.toContain("Crew schedule");
  });
});

describe("buildContextBlock — management-only financials", () => {
  it("renders totals and per-job bid/costs/margin when present", () => {
    const block = buildContextBlock([], {
      financials: {
        totalBid: 250000,
        totalCosts: 180000,
        jobs: [
          { job: "J12 Maple St", bid: 100000, costs: 72000, marginPct: 28, targetMarginPct: 30 },
        ],
      },
    });
    expect(block).toContain("Financials (management-only)");
    expect(block).toContain("$250,000 bid");
    expect(block).toContain("$180,000 costs to date");
    expect(block).toContain("J12 Maple St ($100,000 bid, $72,000 costs, 28% margin, target 30%)");
  });

  it("is completely absent when not provided (installer/foreman never get it)", () => {
    const block = buildContextBlock([], {
      role: "installer",
      appGuide: renderAppGuide(appGuideForRole("installer")),
      assignments: [{ kind: "window", code: "W1", job: "J1", location: "S-01-A" }],
    });
    expect(block).not.toContain("Financials");
    expect(block).not.toContain("margin");
    expect(block).not.toContain("bid");
  });
});

describe("ASK_SYSTEM_PROMPT — access-aware, grounded, defense in depth", () => {
  it("keeps the grounded + cite-your-notes contract", () => {
    const p = ASK_SYSTEM_PROMPT.toLowerCase();
    expect(p).toContain("only");
    expect(p).toContain("cite");
  });

  it("tells the model the context is already role-filtered and not to reveal what it wasn't given", () => {
    const p = ASK_SYSTEM_PROMPT.toLowerCase();
    expect(p).toContain("role");
    expect(p).toContain("filtered");
    expect(p).toContain("financial");
    expect(p).toMatch(/not\b.*(speculate|infer|reveal|invent)/);
  });
});

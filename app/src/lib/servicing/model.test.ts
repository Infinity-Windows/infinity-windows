import { describe, it, expect } from "vitest";
import {
  emptyServiceUnit,
  serviceReadiness,
  serviceSeconds,
  serviceTotals,
  previewService,
  type ServiceSession,
  type ServiceSnapshot,
} from "./model";
import { serviceHoursCsv } from "./export";
const session = {
  id: "time",
  profile_id: "person",
  visit_id: "visit",
  project_id: "job",
  unit_id: "unit",
  shift_id: "shift",
  kind: "unit",
  stage: "Repair",
  description: "",
  started_at: "2026-09-01T08:00:00Z",
  ended_at: "2026-09-01T10:00:00Z",
  end_reason: "stop",
  review_required: false,
  profiles: { display_name: "Worker" },
  time_shifts: {
    clock_in_at: "2026-09-01T08:30:00Z",
    clock_out_at: "2026-09-01T09:30:00Z",
    break_seconds: 0,
    status: "submitted",
    project_id: "job",
  },
} satisfies ServiceSession;
const unit = {
  ...emptyServiceUnit("visit", "job"),
  id: "unit",
  label: "7",
  cause: "manufacturer" as const,
  fail_point: "Hardware",
  repair: "Changed roller",
  verification: "Operates correctly",
  memo_text: "Replaced broken factory roller.",
  outcome: "resolved" as const,
  evidence_exception: "Typed report reviewed; camera unavailable",
};
const data = {
  visit: {
    id: "visit",
    project_id: "job",
    status: "completed",
    details: {},
    reviewed_at: null,
    revision: 1,
    created_by: "person",
    previous_visit_id: null,
    completed_at: "2026-09-01T10:00:00Z",
    reviewed_by: null,
    allocation: null,
    lodging_message_id: null,
    created_at: "2026-09-01T08:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
  },
  units: [unit],
  sessions: [
    {
      ...session,
      started_at: "2026-09-01T08:30:00Z",
      ended_at: "2026-09-01T09:30:00Z",
    },
  ],
  media: [],
} as ServiceSnapshot;
describe("service labor and exports", () => {
  it("clips service work to its parent shift and ignores removed payroll", () => {
    expect(serviceSeconds(session)).toBe(3600);
    expect(
      serviceSeconds({
        ...session,
        time_shifts: { ...session.time_shifts, status: "voided" },
      }),
    ).toBe(0);
  });
  it("keeps mixed unit labor separate from shared travel", () => {
    const d = structuredClone(data);
    d.units.push({ ...unit, id: "second", cause: "customer" });
    d.sessions.push(
      { ...d.sessions[0], id: "second", unit_id: "second" },
      { ...d.sessions[0], id: "third", unit_id: null, kind: "travel" },
    );
    expect(serviceTotals(d)).toEqual({
      total: 10800,
      shared: 3600,
      byCause: { manufacturer: 3600, customer: 3600, installer: 0, pending: 0 },
    });
  });
  it("requires typed reasons for missing evidence and does not block finishing a visit", () => {
    expect(serviceReadiness(data)).toEqual([]);
    expect(
      serviceReadiness({
        ...data,
        units: [{ ...unit, evidence_exception: "" }],
      }),
    ).toContain("evidence");
    expect(
      serviceReadiness({ ...data, units: [{ ...unit, cause: "pending" }] }),
    ).toContain("details");
  });
  it("flags changed or unresolved payroll before a billable report", () => {
    expect(serviceReadiness({ ...data, sessions: [session] })).toContain(
      "time",
    );
    expect(
      serviceReadiness({ ...data, sessions: [{ ...session, ended_at: null }] }),
    ).toContain("running");
  });
  it("exports visit sessions only, with exact decimal hours and escaped descriptions", () => {
    const d = structuredClone(data);
    d.sessions[0].description = '=HYPERLINK("bad")\nsecond line';
    const csv = serviceHoursCsv([d], []);
    expect(csv).toContain("1.000000");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("Pending billing review");
    expect(csv).toContain("Strata");
  });
  it("previews a queued switch without mutating the saved snapshot", () => {
    const d = structuredClone(data);
    d.sessions[0].ended_at = null;
    const next = previewService(d, [
      {
        id: "command",
        userId: "person",
        action: "start",
        data: {
          id: "idle",
          visit_id: "visit",
          expected_session_id: "time",
          unit_id: null,
          kind: "idle",
          at: "2026-09-01T09:00:00Z",
        },
      },
    ])!;
    expect(next.sessions[0].ended_at).toBe("2026-09-01T09:00:00Z");
    expect(next.sessions[1].ended_at).toBeNull();
    expect(d.sessions[0].ended_at).toBeNull();
  });
});

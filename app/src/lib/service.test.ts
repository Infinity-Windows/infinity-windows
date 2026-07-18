import { describe, expect, it } from "vitest";
import {
  activeCaseCount,
  attributeServiceCases,
  ATTRIBUTION_UNKNOWN,
  type ServiceCase,
  type ServiceCaseStatus,
} from "./service";

// Minimal factory: only the fields the pure helpers read matter.
const mk = (
  id: string,
  status: ServiceCaseStatus,
  extra: Partial<ServiceCase> = {},
): ServiceCase => ({
  id,
  window_id: `win-${id}`,
  install_event_id: null,
  project_id: null,
  opening_id: null,
  window_type_id: null,
  installer_id: null,
  status,
  reason: null,
  fail_point: null,
  description: null,
  reported_by: null,
  created_at: "2026-07-17T00:00:00Z",
  scheduled_at: null,
  resolved_by: null,
  resolved_at: null,
  resolution_note: null,
  ...extra,
});

describe("attributeServiceCases", () => {
  const cases: ServiceCase[] = [
    mk("1", "open", { window_type_id: "t-cas", installer_id: "u-a", fail_point: "seal" }),
    mk("2", "resolved", { window_type_id: "t-cas", installer_id: "u-a", fail_point: "seal" }),
    mk("3", "scheduled", { window_type_id: "t-cas", installer_id: "u-b", fail_point: "flashing" }),
    mk("4", "open", { window_type_id: "t-dh", installer_id: "u-b", fail_point: "seal" }),
  ];

  it("groups by window type with per-status counts, worst first", () => {
    const rows = attributeServiceCases(cases, "window_type");
    expect(rows).toEqual([
      { key: "t-cas", total: 3, open: 1, scheduled: 1, resolved: 1 },
      { key: "t-dh", total: 1, open: 1, scheduled: 0, resolved: 0 },
    ]);
  });

  it("groups by installer", () => {
    const rows = attributeServiceCases(cases, "installer");
    expect(rows).toEqual([
      { key: "u-a", total: 2, open: 1, scheduled: 0, resolved: 1 },
      { key: "u-b", total: 2, open: 1, scheduled: 1, resolved: 0 },
    ]);
  });

  it("groups by fail point (the seal is the top driver)", () => {
    const rows = attributeServiceCases(cases, "fail_point");
    expect(rows[0]).toEqual({
      key: "seal",
      total: 3,
      open: 2,
      scheduled: 0,
      resolved: 1,
    });
    expect(rows[1]).toEqual({
      key: "flashing",
      total: 1,
      open: 0,
      scheduled: 1,
      resolved: 0,
    });
  });

  it("collapses missing/blank dimensions into one Unknown bucket", () => {
    const rows = attributeServiceCases(
      [
        mk("a", "open", { fail_point: null }),
        mk("b", "open", { fail_point: "  " }),
        mk("c", "resolved", { fail_point: "seal" }),
      ],
      "fail_point",
    );
    const unknown = rows.find((r) => r.key === ATTRIBUTION_UNKNOWN);
    expect(unknown).toEqual({
      key: ATTRIBUTION_UNKNOWN,
      total: 2,
      open: 2,
      scheduled: 0,
      resolved: 0,
    });
  });

  it("is empty for no cases", () => {
    expect(attributeServiceCases([], "window_type")).toEqual([]);
  });
});

describe("activeCaseCount", () => {
  it("counts open + scheduled, not resolved", () => {
    const cases = [
      mk("1", "open"),
      mk("2", "scheduled"),
      mk("3", "resolved"),
    ];
    expect(activeCaseCount(cases)).toBe(2);
    expect(activeCaseCount([])).toBe(0);
  });
});

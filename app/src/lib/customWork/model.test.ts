import { describe, it, expect } from "vitest";
import {
  areaSqf,
  workerSeconds,
  unitSummary,
  previewCommands,
  type WorkSession,
  type WorkUnit,
} from "./model";
const unit = {
  id: "unit",
  project_id: "job",
  created_by: "me",
  label: "16",
  type_label: "Fixed window",
  facts: { width_in: 48, height_in: 60, installation_complete: "Yes" },
  revision: 1,
} as WorkUnit;
const session = (
  profile: string,
  start: number,
  end: number | null,
  extra: Partial<WorkSession> = {},
): WorkSession => ({
  id: `${profile}-${start}`,
  profile_id: profile,
  shift_id: "shift",
  project_id: "job",
  unit_id: "unit",
  kind: "unit",
  participation: "install",
  stage: "Installing",
  description: "",
  outcome: "finished",
  delay_reason: "",
  started_at: new Date(start * 60000).toISOString(),
  ended_at: end === null ? null : new Date(end * 60000).toISOString(),
  end_reason: "stop",
  shift_status: "submitted",
  revision: 1,
  ...extra,
});
describe("custom work labor", () => {
  it("counts a late helper only for their own minutes", () =>
    expect(workerSeconds([session("a", 0, 60), session("b", 40, 60)])).toBe(
      80 * 60,
    ));
  it("unions overlapping intervals per person without merging different people", () =>
    expect(
      workerSeconds([
        session("a", 0, 60),
        session("a", 30, 90),
        session("b", 30, 60),
      ]),
    ).toBe(120 * 60));
  it("does not finalize open or unsized work as a pricing sample", () => {
    expect(unitSummary(unit, [session("a", 0, null)]).ready).toBe(false);
    expect(
      unitSummary({ ...unit, facts: {} }, [session("a", 0, 60)]).ready,
    ).toBe(false);
    expect(
      unitSummary({ ...unit, facts: { width_in: 48, height_in: 60 } }, [
        session("a", 0, 60, { outcome: "partial" }),
      ]).ready,
    ).toBe(false);
  });
  it("excludes legacy, rejected, unreviewed and implausibly long time from pricing samples", () => {
    expect(
      unitSummary({ ...unit, legacy_time_present: true }, [session("a", 0, 60)])
        .ready,
    ).toBe(false);
    for (const extra of [
      { shift_status: "open" },
      { shift_status: "rejected" },
      { review_required: true },
    ])
      expect(unitSummary(unit, [session("a", 0, 60, extra)]).ready).toBe(false);
    expect(unitSummary(unit, [session("a", 0, 1000)]).ready).toBe(false);
  });
  it("counts a unit area once across multiple visits and helpers", () => {
    expect(areaSqf(unit)).toBe(20);
    expect(
      unitSummary(unit, [session("a", 0, 60), session("b", 40, 60)])
        .hoursPerSqf,
    ).toBeCloseTo(80 / 60 / 20);
  });
  it("previews an atomic unit-to-idle transition and retains its note", () => {
    const running = session("me", 0, null);
    const result = previewCommands(
      [unit],
      [running],
      [
        {
          id: "cmd",
          userId: "me",
          action: "start",
          data: {
            id: "idle",
            shift_id: "shift",
            unit_id: null,
            project_id: "job",
            expected_session_id: running.id,
            at: new Date(30 * 60000).toISOString(),
            description: "Moving windows",
            finish_note: "Frame set",
          },
        },
      ],
    );
    expect(result.sessions.find((s) => s.id === running.id)?.ended_at).toBe(
      result.sessions.find((s) => s.id === "idle")?.started_at,
    );
    expect(result.sessions.find((s) => s.id === running.id)?.description).toBe(
      "Frame set",
    );
  });
  it("attribution keeps the original shift rather than rewriting payroll", () => {
    const result = previewCommands(
      [{ ...unit, project_id: null }],
      [session("me", 0, 30, { project_id: null })],
      [
        {
          id: "cmd",
          userId: "me",
          action: "unit",
          data: { ...unit, revision: 1 },
        },
      ],
    );
    expect(result.sessions[0]).toMatchObject({
      project_id: "job",
      shift_id: "shift",
    });
  });
});

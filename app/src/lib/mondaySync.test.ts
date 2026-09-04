// What a staged Monday row becomes when the office builds it into a real job
// (Wave J, J3). The mapping is the whole point: est_arrival has been synced
// into monday_jobs since the connector shipped and thrown away at build time,
// and an imported job used to arrive claiming to be ready when nobody had
// looked at it.

import { describe, expect, it } from "vitest";
import { buildInputFromMonday, type MondayJob } from "./mondaySync";

const staged: MondayJob = {
  id: "row-1",
  monday_item_id: "9001",
  name: "Sand Hollow",
  group_title: "Ready to Schedule",
  status: "Ready",
  job_type: "New construction",
  start_date: "2026-10-05",
  end_date: "2026-10-20",
  est_arrival: "2026-09-15",
  budget: 82000,
  flashing_note: "Peel and stick",
  synced_at: "2026-09-03T13:00:00Z",
  project_id: null,
  dismissed_at: null,
};

const office = { jobCode: "SANDHOLLOW", name: "Sand Hollow" };

describe("buildInputFromMonday", () => {
  it("carries Monday's arrival estimate over as the job's windows ETA", () => {
    expect(buildInputFromMonday(staged, office).materialsEta).toBe("2026-09-15");
  });

  it("makes an imported job Not ready — nobody has walked that site", () => {
    expect(buildInputFromMonday(staged, office).readyState).toBe("not_ready");
  });

  it("keeps everything the office typed", () => {
    const out = buildInputFromMonday(staged, {
      ...office,
      name: "Sand Hollow — Phase 2",
      notes: "Imported from Monday.com",
      startDate: "2026-10-05",
    });
    expect(out.jobCode).toBe("SANDHOLLOW");
    expect(out.name).toBe("Sand Hollow — Phase 2");
    expect(out.notes).toBe("Imported from Monday.com");
    expect(out.startDate).toBe("2026-10-05");
  });

  it("leaves the ETA empty when Monday has no arrival date", () => {
    const out = buildInputFromMonday({ ...staged, est_arrival: null }, office);
    expect(out.materialsEta).toBeNull();
    // Still Not ready: not knowing when the windows come is a reason to check,
    // not a reason to assume everything is fine.
    expect(out.readyState).toBe("not_ready");
  });

  it("never overrides a decision the caller made", () => {
    const out = buildInputFromMonday(staged, {
      ...office,
      readyState: "ready",
      materialsEta: "2026-09-30",
    });
    expect(out.readyState).toBe("ready");
    expect(out.materialsEta).toBe("2026-09-30");
  });
});

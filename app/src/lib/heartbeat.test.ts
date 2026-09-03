import { describe, expect, it } from "vitest";
import {
  ANOMALY_THRESHOLD,
  heartbeatTask,
  isAnomaly,
  liveCrewHref,
  type OpeningRow,
} from "./heartbeat";

/**
 * The Heartbeat flags a running task as "long" when elapsed time exceeds the
 * learned median by the threshold multiple. No median → never a false alarm.
 */
describe("isAnomaly", () => {
  it("flags when elapsed exceeds median * threshold", () => {
    // 10-min window (600s), threshold 2.0 → anomaly past 1200s.
    expect(isAnomaly(1300, 600)).toBe(true);
    expect(isAnomaly(1201, 600)).toBe(true);
  });

  it("does not flag at or below the threshold multiple", () => {
    expect(isAnomaly(1200, 600)).toBe(false); // exactly 2x is not "over"
    expect(isAnomaly(900, 600)).toBe(false);
    expect(isAnomaly(0, 600)).toBe(false);
  });

  it("never flags without a usable median", () => {
    expect(isAnomaly(99999, null)).toBe(false);
    expect(isAnomaly(99999, undefined)).toBe(false);
    expect(isAnomaly(99999, 0)).toBe(false);
    expect(isAnomaly(99999, -5)).toBe(false);
  });

  it("honors a custom threshold", () => {
    // 10-min window, threshold 1.5 → anomaly past 900s.
    expect(isAnomaly(1000, 600, 1.5)).toBe(true);
    expect(isAnomaly(800, 600, 1.5)).toBe(false);
  });

  it("uses a 2.0 default threshold", () => {
    expect(ANOMALY_THRESHOLD).toBe(2.0);
    expect(isAnomaly(600 * ANOMALY_THRESHOLD + 1, 600)).toBe(true);
  });
});

/**
 * Live crew read `work_started_at` straight into a counter, so three forgotten
 * taps showed as installs running for 300+ hours against windows nobody had
 * touched since July. The number was arithmetically right and told the office
 * nothing true.
 */
describe("heartbeatTask", () => {
  const NOW = Date.parse("2026-07-30T21:00:00Z");
  const row = (over: Partial<OpeningRow> = {}): OpeningRow => ({
    id: "o1",
    project_id: "p1",
    opening_code: "C101",
    label: "Unit C101 living",
    status: "planned",
    work_started_at: new Date(NOW - 25 * 60000).toISOString(),
    assignee: { display_name: "Ammon" },
    window_types: { median_minutes: 30 },
    ...over,
  });

  it("reports a genuine install as running, with its elapsed time", () => {
    const t = heartbeatTask(row(), NOW);
    expect(t?.stale).toBe(false);
    expect(t?.elapsedSec).toBe(25 * 60);
    expect(t?.installerName).toBe("Ammon");
  });

  it("flags the OAKRIDGE C101 stamp instead of counting it", () => {
    const t = heartbeatTask(
      row({ work_started_at: "2026-07-17T06:05:21.809172Z" }),
      NOW,
    );
    expect(t?.stale).toBe(true);
    // Still reported, because the office is who should settle it — hiding it
    // would just make the stamp somebody else's surprise later.
    expect(t?.openingId).toBe("o1");
  });

  it("does not also call an abandoned stamp 'running long'", () => {
    // 327 hours against a 30-minute median is not a slow install, and saying
    // "long vs median" would send a foreman looking for a struggling installer.
    const t = heartbeatTask(
      row({ work_started_at: "2026-07-17T06:05:21.809172Z" }),
      NOW,
    );
    expect(t?.anomaly).toBe(false);
  });

  it("still calls a genuinely slow install long", () => {
    const t = heartbeatTask(
      row({ work_started_at: new Date(NOW - 70 * 60000).toISOString() }),
      NOW,
    );
    expect(t?.stale).toBe(false);
    expect(t?.anomaly).toBe(true);
  });

  it("says Unassigned when nobody is on the window", () => {
    // Which is what two of the three stale ones showed — nobody was assigned.
    expect(heartbeatTask(row({ assignee: null }), NOW)?.installerName).toBe("Unassigned");
  });

  it("ignores windows nobody started and windows already installed", () => {
    expect(heartbeatTask(row({ work_started_at: null }), NOW)).toBeNull();
    expect(heartbeatTask(row({ status: "installed" }), NOW)).toBeNull();
  });

  it("ignores an unreadable stamp rather than showing NaN", () => {
    expect(heartbeatTask(row({ work_started_at: "nonsense" }), NOW)).toBeNull();
  });
});

/**
 * Live crew rows link straight to the unit's own opening sheet — the same
 * deep link MapsInteractive's openOpening uses — so a stale start gets
 * resolved on the row that flags it instead of sending someone hunting.
 */
describe("liveCrewHref", () => {
  it("points at the opening sheet for that project and opening", () => {
    expect(liveCrewHref({ projectId: "p1", openingId: "o1" })).toBe(
      "/projects/p1/opening/o1",
    );
  });

  it("works from a full HeartbeatTask, not just the two id fields", () => {
    const t = heartbeatTask(
      {
        id: "o1",
        project_id: "p1",
        opening_code: "C101",
        label: "Unit C101 living",
        status: "planned",
        work_started_at: new Date(Date.now() - 60_000).toISOString(),
        assignee: { display_name: "Ammon" },
        window_types: { median_minutes: 30 },
      },
      Date.now(),
    );
    expect(t).not.toBeNull();
    expect(liveCrewHref(t!)).toBe(`/projects/${t!.projectId}/opening/${t!.openingId}`);
  });
});

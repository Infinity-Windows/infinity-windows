// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import type { UseQueryResult } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { PlanBlock } from "../../lib/installerWorkflow/jobPlan";
import type { PlannedJob } from "../../lib/installerWorkflow/sharedPlan";
import type { ScheduleAssignment } from "../../lib/schedule/types";
import { AssignedPlan } from "./AssignedPlan";

vi.mock("../../lib/i18n", () => ({ useLanguage: () => ({ lang: "en" }) }));
vi.mock("./AgendaUnitDetails", () => ({ AgendaUnitDetails: () => null }));

it("groups blocks under the day they start, named by its date", () => {
  const block = (id: string, activity: PlanBlock["activity"], start: string, end: string): PlanBlock => ({
    id, activity, kind: "unit", start, end, openingIds: [], installerIds: [],
  });
  const plan = {
    data: [{
      projectId: "test-job", jobCode: "TEST", jobName: "Test job", unitLabels: {},
      blocks: [
        block("later", "Staging", "2026-11-23", "2026-11-23"),
        block("soon", "Sealing", "2026-11-22", "2026-11-24"),
        block("multi-day", "Setting frame", "2026-11-19", "2026-11-21"),
        block("today", "Flashing", "2026-11-19", "2026-11-19"),
        block("already-started", "RO checked", "2026-11-18", "2026-11-20"),
        block("outside-window", "Problem-solving", "2026-12-03", "2026-12-03"),
      ],
    }],
  } as UseQueryResult<PlannedJob[]>;
  const markup = renderToStaticMarkup(<AssignedPlan profileId="installer" today="2026-11-19" plan={plan} />);
  const container = document.createElement("div");
  container.innerHTML = markup;
  const groups = Array.from(container.querySelectorAll(".ws-plan-date"));
  expect(groups.map(group => group.querySelector("h3")?.textContent)).toEqual(["Today", "Sun, Nov 22", "Mon, Nov 23"]);
  expect(groups.map(group => Array.from(group.querySelectorAll("article strong"), row => row.textContent)))
    .toEqual([["Setting frame", "Flashing"], ["Sealing"], ["Staging"]]);
});

it("lists a scheduled job nobody has planned yet, and not one whose planned work already shows", () => {
  const booking = (id: string, projectId: string, name: string, start: string, end: string) => ({
    id, project_id: projectId, project: { job_code: name.toUpperCase(), name }, status: "published",
    start_date: start, end_date: end, start_time: "07:00:00", members: [{ profile_id: "installer" }],
  }) as unknown as ScheduleAssignment;
  const plan = {
    data: [{
      projectId: "planned-job", jobCode: "PLANNED", jobName: "Planned job", unitLabels: {},
      blocks: [{ id: "b", activity: "Sealing", kind: "unit", start: "2026-11-20", end: "2026-11-20", openingIds: [], installerIds: [] }],
    }],
  } as unknown as UseQueryResult<PlannedJob[]>;
  const markup = renderToStaticMarkup(<AssignedPlan profileId="installer" today="2026-11-19" plan={plan} scheduled={[
    booking("s1", "planned-job", "Planned job", "2026-11-19", "2026-11-21"),
    booking("s2", "booked-job", "Booked job", "2026-11-25", "2026-11-26"),
    booking("s3", "far-job", "Far job", "2026-12-10", "2026-12-10"),
  ]} />);
  const container = document.createElement("div");
  container.innerHTML = markup;
  const jobs = Array.from(container.querySelectorAll(".ws-plan-job"), job =>
    [job.querySelector("h4")?.textContent, ...Array.from(job.querySelectorAll("article strong"), row => row.textContent)]);
  expect(jobs).toEqual([["Planned job", "Sealing"], ["Booked job", "Scheduled"]]);
  const last = Array.from(container.querySelectorAll(".ws-plan-date")).at(-1);
  expect(last?.querySelector("h3")?.textContent).toBe("Wed, Nov 25");
  expect(last?.querySelector(".ws-plan-meta")?.textContent).toMatch(/through Thu, Nov 26.*7:00/);
});

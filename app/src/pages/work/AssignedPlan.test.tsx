// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import type { UseQueryResult } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { PlanBlock } from "../../lib/installerWorkflow/jobPlan";
import type { PlannedJob } from "../../lib/installerWorkflow/sharedPlan";
import { AssignedPlan } from "./AssignedPlan";

vi.mock("../../lib/i18n", () => ({ useLanguage: () => ({ lang: "en" }) }));
vi.mock("./AgendaUnitDetails", () => ({ AgendaUnitDetails: () => null }));

it("groups blocks by start day regardless of their end date", () => {
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
  expect(groups.map(group => group.querySelector("h3")?.textContent)).toEqual(["Today", "Next few days", "Remaining"]);
  expect(groups.map(group => Array.from(group.querySelectorAll("article strong"), row => row.textContent)))
    .toEqual([["Setting frame", "Flashing"], ["Sealing"], ["Staging"]]);
});

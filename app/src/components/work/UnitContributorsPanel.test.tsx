// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import corpus from "../../lib/workUnitContributions/__fixtures__/sourceMatchedWire.json";
import { parseUnitContributorsReply, type UnitContributorsView } from "../../lib/workUnitContributions/protocol";
import { UnitContributorsPanel, type UnitContributorsPanelRead } from "./UnitContributorsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function sqlView(label: string): UnitContributorsView {
  const call = corpus.calls.find(row => row.label === label);
  if (!call || call.reply.availability !== "available" || !call.reply.contributors) throw Error(`Missing SQL view ${label}`);
  const reply = parseUnitContributorsReply(call.reply, {
    actorId: call.reply.contributors.actorId, projectId: call.request.projectId,
    unitId: call.request.unitId, unitIncarnation: call.reply.contributors.unitIncarnation,
  });
  if (reply.availability !== "available") throw Error(`SQL view unavailable: ${label}`);
  return structuredClone(reply.contributors);
}
function ready(data: UnitContributorsView): UnitContributorsPanelRead { return { state: "ready", data }; }
async function show(read: UnitContributorsPanelRead, locale: "en" | "es" = "en", onCheck = vi.fn(), disabled = false) {
  await act(async () => root.render(<UnitContributorsPanel locale={locale} read={read} onCheck={onCheck} disabled={disabled} />));
  return onCheck;
}

describe("unmounted selected-unit contributor presentation", () => {
  it("shows exact total and 3h/2h/1h shares without payroll or area claims", async () => {
    const view = sqlView("three_people_3_2_1_hours");
    await show(ready(view));
    expect(host.textContent).toContain("6:00:00");
    expect(host.textContent).toContain("3:00:00");
    expect(host.textContent).toContain("2:00:00");
    expect(host.textContent).toContain("1:00:00");
    expect(host.textContent).toContain("50.00%");
    expect(host.textContent).toContain("33.33%");
    expect(host.textContent).toContain("16.67%");
    expect(host.querySelectorAll(".unit-contrib-person-list details")).toHaveLength(3);
    const idCues = Array.from(host.querySelectorAll(".unit-contrib-person-list summary"), row => row.textContent?.match(/ID: …([0-9a-f-]+)/)?.[1]);
    expect(idCues.every(Boolean)).toBe(true);
    expect(new Set(idCues).size).toBe(3);
    expect(host.textContent).not.toMatch(/payroll|salary|square feet|area rate/i);
  });
  it("keeps a partial known subtotal and an unproven named person out of percentages", async () => {
    const view = sqlView("same_person_unproven_timer_and_named_work");
    await show(ready(view));
    expect(host.textContent).toContain("Partial recorded total");
    expect(host.textContent).toContain("0:00:00.3");
    expect(host.textContent).toContain("Time not established");
    expect(host.textContent).toContain("Also listed with time evidence");
    expect(host.textContent).toContain("Older time cannot be fully mapped");
    expect(host.textContent).not.toMatch(/100\.00%|50\.00%/);
    expect(host.querySelectorAll(".unit-contrib-person-list details")).toHaveLength(2);
    expect(host.querySelectorAll(".unit-contrib-secondary[aria-label='Named work; time unknown'] details")).toHaveLength(2);
  });
  it("does not count a zero-only audit as worked labor beside a positive unit", async () => {
    await show(ready(sqlView("positive_unit_with_zero_only_audit")));
    expect(host.textContent).toContain("2:00:00");
    expect(host.textContent).toContain("Zero-duration timer records");
    expect(host.textContent).toContain("These entries are not counted as worked people or hours");
    expect(host.querySelectorAll(".unit-contrib-person-list details")).toHaveLength(2);
    expect(host.querySelectorAll(".unit-contrib-person--zero")).toHaveLength(1);
    expect(host.textContent).toContain("50.00%");
    expect(host.querySelector(".unit-contrib-person--zero")?.textContent).not.toContain("% share");
  });
  it("keeps named-only evidence separate, with date and source reference", async () => {
    const view = sqlView("same_person_unproven_timer_and_named_work");
    await show(ready(view));
    const named = host.querySelector(".unit-contrib-person--evidence");
    expect(named?.textContent).toContain("Work evidence");
    expect(named?.textContent).toContain(view.untimedParticipants[0].evidence[0].sourceId);
    expect(host.textContent).toContain("Work date");
    expect(host.textContent).toContain("Named work; time unknown");
  });
  it("shows unknown and inactive names without inventing an identity", async () => {
    const unavailable = sqlView("Blank existing name is unavailable without inventing missing identity");
    await show(ready(unavailable));
    expect(host.textContent).toContain("Name unavailable");
    const retired = sqlView("Retired worker remains in historical attribution");
    await show(ready(retired));
    expect(host.textContent).toContain("Inactive profile");
  });
  it("immediately hides private values when the read is held, loading, or unavailable", async () => {
    const data = sqlView("three_people_3_2_1_hours");
    await show(ready(data));
    const privateName = data.people[0].displayName!;
    expect(host.textContent).toContain(privateName);
    for (const state of ["held", "loading", "unavailable"] as const) {
      await show({ state, data }); // Deliberately stale data must not leak.
      expect(host.textContent).not.toContain(privateName);
      expect(host.textContent).not.toContain("6:00:00");
      expect(host.querySelectorAll("details")).toHaveLength(0);
    }
  });
  it("fails closed if a ready payload cannot reconcile to the whole unit", async () => {
    const data = sqlView("three_people_3_2_1_hours");
    const privateName = data.people[0].displayName!;
    data.unitKnownMicros = "1";
    await show(ready(data));
    expect(host.textContent).toContain("This breakdown is unavailable");
    expect(host.textContent).not.toContain(privateName);
    expect(host.querySelectorAll("details")).toHaveLength(0);
  });
  it("shows each task version and treats machine time as an included subset", async () => {
    const view = sqlView("two_tasks_machine_subset_not_extra_timer");
    await show(ready(view));
    expect(host.textContent).toContain("2:00:00");
    expect(host.querySelectorAll(".unit-contrib-task-list > li")).toHaveLength(2);
    expect(host.textContent).toContain("Version 1");
    expect(host.textContent).toContain("Machine time is included in the activity above");
    expect(host.textContent).toContain("Forklift");
  });
  it("offers English and Spanish check controls and native keyboard-expandable details", async () => {
    const checked = vi.fn(), view = sqlView("three_people_3_2_1_hours");
    await show(ready(view), "en", checked);
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("Check current records");
    expect(button.getAttribute("type")).toBe("button");
    await act(async () => button.click());
    expect(checked).toHaveBeenCalledTimes(1);
    expect(host.querySelector("details > summary")).not.toBeNull();
    await show(ready(view), "es", checked);
    expect(host.textContent).toContain("Quién trabajó en esta unidad");
    expect(host.textContent).toContain("Consultar registros actuales");
    expect(host.textContent).toContain("Porcentaje de mano de obra de la unidad");
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("Quién trabajó en esta unidad");
    await show(ready(view), "en", checked, true);
    expect(host.querySelector("button")?.disabled).toBe(true);
  });
  it("wraps rather than truncates long source names and activity labels in the DOM", async () => {
    const view = sqlView("three_people_3_2_1_hours");
    view.people[0].displayName = "Very long field technician ".repeat(15);
    view.people[0].activities[0].labelEn = "Long custom installation activity ".repeat(12);
    await show(ready(view));
    expect(host.textContent).toContain(view.people[0].displayName);
    expect(host.textContent).toContain(view.people[0].activities[0].labelEn.trim());
  });
  it("renders unknown machine kinds without inherited dictionary entries", async () => {
    const view = sqlView("two_tasks_machine_subset_not_extra_timer");
    view.people[0].activities.find(row => row.machineSubsets.length)!.machineSubsets[0].machineKind = "toString";
    await show(ready(view));
    expect(host.textContent).toContain("toString");
    expect(host.textContent).not.toContain("undefined");
  });
  it("disambiguates equal names across timed and named evidence without duplicating the same person", async () => {
    const view = sqlView("same_person_unproven_timer_and_named_work");
    for (const person of [...view.people, ...view.untimedParticipants]) {
      person.nameState = "current"; person.displayName = "Same name";
    }
    await show(ready(view));
    const summaries = Array.from(host.querySelectorAll(".unit-contrib-person summary"));
    expect(summaries.every(row => row.textContent?.includes("ID: …"))).toBe(true);
    for (const person of view.untimedParticipants) {
      expect(host.textContent).toContain(person.profileId);
    }
  });

});

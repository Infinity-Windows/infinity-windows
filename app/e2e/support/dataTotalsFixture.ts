import { expect, type Page } from "@playwright/test";
import { FIXTURE_AUTH_KEY, FIXTURE_SESSION, TEST_USER } from "./supabaseFixtures";
import corpus from "../../src/lib/workActivityTotals/__fixtures__/sourceMatchedWire.json" with { type: "json" };
export const DATA_PROJECT = "00000000-0000-4000-8000-000000800001";
export const DATA_OTHER = "00000000-0000-4000-8000-000000800002";
export const DATA_UNIT = "00000000-0000-4000-8000-000000800003";
const FACT = "00000000-0000-4000-8000-000000800004";
const stamp = "2026-10-04T12:00:00.000000Z";
export function dataUnitBasis() { return { id: DATA_UNIT, projectId: DATA_PROJECT, openingId: null, operationalRevision: 2,
  incarnationEpoch: 1, bindingEpoch: 1, projectEpoch: 1, openingEpoch: null,
  fact: { id: FACT, revision: 1, eventKind: "observation", originProjectEpoch: 1, originOpeningEpoch: null,
    dimensions: { widthIn: 48, heightIn: 36, source: "measured", original: { width: 48, height: 36, unit: "in", source: "measured", sourceReference: null } }, estimated: false },
  eligibleForCapture: true, ineligibleReason: null }; }
export function dataTotalsReply(unitId: string | null, mode = "eligible", projectId = DATA_PROJECT) {
  if (mode === "unavailable") return { protocolVersion: 1, availability: "unavailable", totals: null };
  const qcMissing = corpus.calls.findIndex(call => {
    const cohort = call.result.totals?.cohort;
    const reasons = cohort?.availability === "available" ? cohort.exclusions : undefined;
    return Array.isArray(reasons) && reasons.length === 1 && reasons[0] === "qc_not_current_accepted";
  });
  if (mode === "qc_missing" && qcMissing < 0) throw Error("SQL corpus lacks a noncurrent-QC reply");
  const reply = structuredClone(corpus.calls[unitId ? mode === "partial" ? 2 : mode === "qc_missing" ? qcMissing : 8 : 0].result), t = reply.totals!;
  t.actorId = TEST_USER.id; t.projectId = projectId; t.unitId = unitId;
  if (t.cohort.availability === "available") { t.cohort.unitId = unitId!; t.cohort.eligibleUnitIds = t.cohort.eligible ? [unitId!] : []; }
  return reply;
}
export async function setupDataTotals(page: Page, release = true, role = "owner") {
  const server = { mode: "eligible", foreignBasis: false, totalsCalls: [] as { p_project_id: string; p_unit_id: string | null }[], reportCalls: [] as { p_project_id: string; p_from: string; p_until: string }[], unexpected: [] as string[], pageErrors: [] as string[] };
  page.on("pageerror", error => server.pageErrors.push(error.message));
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: FIXTURE_AUTH_KEY, session: FIXTURE_SESSION });
  // Fixture-only gate override. The production constant remains false on disk.
  await page.route("**/src/lib/paidClock/ClockFlowBridge.tsx", r => r.fulfill({ contentType: "application/javascript", body: `export const PAID_SETUP_RELEASE_AUTHORIZED=${release}; export default function(){return null;}` }));
  await page.route("https://**/*", async route => {
    const url = new URL(route.request().url()), endpoint = url.pathname.split("/").pop();
    // Static fonts are intentionally unavailable in this isolated fixture.
    if (["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) return route.abort();
    if (!url.hostname.endsWith("e2efixture.supabase.co")) { server.unexpected.push(url.hostname); return route.abort(); }
    const args = route.request().method() === "POST" ? route.request().postDataJSON() : null;
    const send = (value: unknown) => route.fulfill({ contentType: "application/json", headers: { "content-range": "0-0/1", "access-control-expose-headers": "content-range" }, body: JSON.stringify(value) });
    if (endpoint === "user") return send(TEST_USER);
    if (endpoint === "profiles") return send({ ...TEST_USER, display_name: "Synthetic Data Owner", role, retired_at: null, active: true });
    if (endpoint === "projects") return send([{ id: DATA_PROJECT, name: "Black Desert fixture", job_code: "BLACK22", active: true }, { id: DATA_OTHER, name: "Second job fixture", job_code: "SECOND", active: false }]);
    if (endpoint === "custom_work_units") return send([{ id: DATA_UNIT, project_id: DATA_PROJECT, opening_id: null, label: "Unit 42", type_label: "Aluminum bifold", facts: {}, revision: 2, created_by: TEST_USER.id, created_at: stamp, updated_at: stamp }]);
    if (endpoint === "work_activity_catalog") return send({ protocolVersion: 1, asOf: stamp, availability: "available", projectId: args.p_project_id, unit: args.p_unit_id ? dataUnitBasis() : null, selection: null, totals: { availability: "unavailable", reasonCode: "not_ready" } });
    if (endpoint === "work_activity_unit_basis") return send({ protocolVersion: 1, asOf: stamp, availability: "available", unit: { ...dataUnitBasis(), bindingEpoch: server.foreignBasis ? 2 : 1 } });
    if (endpoint === "work_activity_totals_read") { server.totalsCalls.push(args); return send(dataTotalsReply(args.p_unit_id, server.mode, args.p_project_id)); }
    if (endpoint === "work_data_snapshot") {
      server.reportCalls.push(args);
      // Synthetic older evidence remains separate, not trusted-QC proof.
      return send({ schemaVersion: 1, asOf: stamp, project: { id: args.p_project_id, jobCode: "BLACK22", name: "Date-bounded fixture" },
        shifts: [{ id: "legacy-shift", profileId: "legacy-worker", profileName: "Legacy worker", projectId: args.p_project_id, startedAt: "2026-10-04T08:00:00Z", endedAt: "2026-10-04T09:00:00Z", breakSeconds: 0, breakStartedAt: null, status: "approved", reviewReason: null }],
        claims: [{ sourceId: "legacy-source", sourceTable: "crew_work_records", revision: 1, profileId: "legacy-worker", projectId: args.p_project_id, shiftId: "legacy-shift", unitId: "opening:legacy-window", activityId: "measuring", label: "Legacy measuring", scope: "specific", startedAt: "2026-10-04T08:00:00Z", endedAt: "2026-10-04T09:00:00Z" }],
        units: [{ id: "opening:legacy-window", label: "Legacy window", category: "Window", subtype: "Fixed", material: "Vinyl", floor: "1", widthIn: 48, heightIn: 36, dimensionSource: "plans", dimensionsVerified: false, complete: true, qcAccepted: false, hasUntimedEvidence: false }], untimed: [] });
    }
    server.unexpected.push(url.pathname); return route.abort();
  });
  await page.goto("/e2e/support/data-totals.html");
  if (role === "owner" || role === "supervisor") {
    await expect(page.getByRole("combobox", { name: "Job", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Job", exact: true }).selectOption(DATA_PROJECT);
    await expect(page.getByText("Legacy measuring", { exact: true }).first()).toBeVisible();
  }
  return server;
}

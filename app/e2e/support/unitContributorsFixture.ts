import { expect, type Page } from "@playwright/test";
import corpus from "../../src/lib/workUnitContributions/__fixtures__/sourceMatchedWire.json" with { type: "json" };
import { TEST_USER } from "./supabaseFixtures";
import { PROJECT, UNIT, setupMountedReview } from "./mountedUnitReviewFixture";
import { DATA_PROJECT, DATA_UNIT, setupDataTotals } from "./dataTotalsFixture";

// These are actual PostgreSQL wire replies. Only fixture actor, job, unit and
// incarnation identities are rebound. This tests the native consumer, not SQL.
export function contributorReply(index: 32 | 34 | 35 | 36, project = PROJECT, unit = UNIT, incarnation = "2") {
  const reply = structuredClone(corpus.calls[index].reply);
  if (reply.availability !== "available" || !reply.contributors) throw Error(`Missing SQL reply ${index}`);
  reply.contributors.actorId = TEST_USER.id;
  reply.contributors.projectId = project;
  reply.contributors.unitId = unit;
  reply.contributors.unitIncarnation = incarnation;
  return reply;
}

export async function setupWorkContributors(page: Page, role: "owner" | "supervisor" | "foreman" | "installer" | "partner" = "owner") {
  const server = { reads: 0, pending: [] as (() => void)[], hold: false, mode: 32 as 32 | 34 | 35 | 36,
    requests: [] as unknown[], unexpected: [] as string[], pageErrors: [] as string[] };
  page.on("pageerror", error => server.pageErrors.push(error.message));
  const unexpected = await setupMountedReview(page, async () => {
    await page.route("**/rest/v1/profiles*", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ ...TEST_USER, display_name: "Synthetic viewer", role, retired_at: null, active: true }) }));
    await page.route("**/rest/v1/rpc/work_unit_review_read", route => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ protocolVersion: 1, asOf: new Date().toISOString(), availability: "unavailable", review: null }) }));
    await page.route("**/rest/v1/rpc/work_unit_contributors_read", async route => {
      const args = route.request().postDataJSON();
      server.reads++; server.requests.push(args);
      if (server.hold) await new Promise<void>(resolve => server.pending.push(resolve));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(contributorReply(server.mode)) });
    });
  });
  server.unexpected = unexpected;
  await expect(page.locator(".pav")).toBeVisible();
  return server;
}

export async function chooseWorkUnit(page: Page) {
  await page.getByRole("tab", { name: "Specific", exact: true }).click();
  await page.getByRole("combobox", { name: "Choose a unit" }).selectOption(UNIT);
  await expect(page.getByRole("region", { name: "Who worked on this unit" })).toBeVisible();
}

export async function setupDataContributors(page: Page) {
  const data = await setupDataTotals(page);
  const server = { data, reads: 0, requests: [] as unknown[], pending: [] as (() => void)[], hold: false,
    mode: 32 as 32 | 34 | 35 | 36 };
  // The generic Data fixture has a fallback router. This later, narrower
  // route takes precedence and leaves the existing fixture untouched.
  await page.route("**/rest/v1/rpc/work_unit_contributors_read", async route => {
    const args = route.request().postDataJSON();
    server.reads++; server.requests.push(args);
    if (server.hold) await new Promise<void>(resolve => server.pending.push(resolve));
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(contributorReply(server.mode, DATA_PROJECT, DATA_UNIT, "1")) });
  });
  return server;
}

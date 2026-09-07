// Job facts after the owner's first look (2026-09-07): a house is more than
// one finish, so the card takes a LIST of exterior situations; "Other" on a
// pick-list opens a box to name the real thing; the sill pan is gone; the
// GC's name and number live on the GC card up top.
//
// What this proves that a unit test cannot:
//   - a foreman adds a situation, fills it in, and ONE upsert_build_facts RPC
//     goes over carrying the whole list in the shape the server validates;
//   - choosing "Other" for flashing reveals the "Which one?" box, and its
//     text is saved under flashing_system_other;
//   - the fields the owner removed are not on the page, and the GC's phone is
//     on the GC card, not the Job facts card.

import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const PROJECT_ID = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";

const PROJECT = {
  id: PROJECT_ID,
  job_code: "SANDHOLLOW",
  name: "Sand Hollow",
  address: null,
  status: "active",
  is_test: false,
  allowed_modes: ["data"],
  start_date: null,
  sort_order: 1,
  gc_brand: "stg",
  project_pipeline: { ready_state: "not_ready", materials_eta: null, materials_arrived_at: null },
};

const FACTS_ROW = {
  project_id: PROJECT_ID,
  exterior_lines: [
    { exterior_finish: "stucco", exterior_note: "sides", set_depth: "inset", set_depth_inches: 1.25 },
  ],
  flashing_system: null,
  flashing_system_other: null,
  flashing_note: null,
  fastener_type: null,
  fastener_type_other: null,
  fastener_length_in: null,
  fastener_spacing_in: null,
  fastener_note: null,
  site_rules: null,
  gc_contact_name: "Dave at Dixie",
  gc_contact_phone: "435-555-0100",
  elevation_notes: null,
  updated_by: null,
  updated_at: "2026-09-07T12:00:00Z",
};

function useFactsFixtures(page: Page, row: typeof FACTS_ROW | null) {
  const calls: Record<string, unknown>[] = [];
  let stored = row;

  void page.route("**/rest/v1/projects**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, PROJECT, 1);
    return json(r, [PROJECT], 1);
  });
  void page.route("**/rest/v1/project_gc_checkins**", (r) => json(r, [], 0));
  void page.route("**/rest/v1/gc_links**", (r) => json(r, [], 0));
  void page.route("**/rest/v1/project_build_facts**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, stored, stored ? 1 : 0);
    return json(r, stored ? [stored] : [], stored ? 1 : 0);
  });
  void page.route("**/rest/v1/rpc/upsert_build_facts", async (r) => {
    const body = r.request().postDataJSON() as { p_project_id: string; p_patch: Record<string, unknown> };
    calls.push(body.p_patch);
    stored = { ...(stored ?? FACTS_ROW), ...body.p_patch, updated_at: new Date().toISOString() } as typeof FACTS_ROW;
    return json(r, stored, 1);
  });
  void page.route("**/rest/v1/rpc/green_light_items", (r) => json(r, [], 0));

  return { calls };
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const factsCard = (page: Page) =>
  page
    .locator("section.detail-card")
    .filter({ has: page.getByRole("heading", { name: "Job facts", exact: true }) });

const gcCard = (page: Page) =>
  page
    .locator("section.detail-card")
    .filter({ has: page.getByRole("heading", { name: "GC", exact: true }) });

test("a foreman adds a second exterior situation and the whole list goes over in one RPC", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const { calls } = useFactsFixtures(page, FACTS_ROW);
  await page.goto(`/projects/${PROJECT_ID}`);

  const card = factsCard(page);
  await expect(card).toBeVisible();

  // The stored situation is on screen, and the owner's removed fields are not.
  const lines = card.locator(".build-facts-line");
  await expect(lines).toHaveCount(1);
  await expect(lines.first().getByLabel("Exterior finish", { exact: true })).toHaveValue("stucco");
  await expect(card.getByLabel(/sill pan/i)).toHaveCount(0);
  await expect(card.getByLabel(/north elevation/i)).toHaveCount(0);
  await expect(card.getByLabel("GC phone")).toHaveCount(0);
  await expect(card.getByLabel("Elevation notes")).toBeVisible();

  await card.getByRole("button", { name: "Add a situation" }).click();
  await expect(lines).toHaveCount(2);

  const second = lines.nth(1);
  await second.getByLabel("Exterior finish", { exact: true }).selectOption("brick");
  await second.getByLabel("Set depth", { exact: true }).selectOption("outset");
  await second.getByLabel("Set depth (inches)").fill("1");
  await second.getByLabel("Set depth (inches)").blur();

  // Every change saves the whole list, so three edits are three RPCs; the
  // one that matters is the last, once the inch has gone over.
  type Patch = { exterior_lines?: Record<string, unknown>[] };
  const lastPatch = () => calls[calls.length - 1] as Patch | undefined;
  await expect
    .poll(() => lastPatch()?.exterior_lines?.[1]?.set_depth_inches ?? null, { timeout: 45_000 })
    .toBe(1);
  const last = lastPatch() as { exterior_lines: Record<string, unknown>[] };
  expect(last.exterior_lines).toHaveLength(2);
  expect(last.exterior_lines[0]).toMatchObject({ exterior_finish: "stucco", set_depth: "inset", set_depth_inches: 1.25 });
  expect(last.exterior_lines[1]).toMatchObject({ exterior_finish: "brick", set_depth: "outset", set_depth_inches: 1 });
});

test("choosing Other for flashing opens a box to name it", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const { calls } = useFactsFixtures(page, FACTS_ROW);
  await page.goto(`/projects/${PROJECT_ID}`);

  const card = factsCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByLabel("Which one?")).toHaveCount(0);

  await card.getByLabel("Flashing system").selectOption("other");
  await expect.poll(() => calls.length, { timeout: 45_000 }).toBeGreaterThan(0);
  expect(calls[calls.length - 1]).toEqual({ flashing_system: "other" });

  // The card re-reads the row and the box appears beside the list.
  const which = card.getByLabel("Which one?").first();
  await expect(which).toBeVisible({ timeout: 15_000 });
  await which.fill("FlexWrap");
  await which.blur();
  await expect.poll(() => calls.length, { timeout: 45_000 }).toBeGreaterThan(1);
  expect(calls[calls.length - 1]).toEqual({ flashing_system_other: "FlexWrap" });
});

test("the GC's name and number are on the GC card, editable by a foreman", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  const { calls } = useFactsFixtures(page, FACTS_ROW);
  await page.goto(`/projects/${PROJECT_ID}`);

  const card = gcCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByLabel("GC contact")).toHaveValue("Dave at Dixie");
  const phone = card.getByLabel("GC phone");
  await expect(phone).toHaveValue("435-555-0100");

  await phone.fill("435-555-0199");
  await phone.blur();
  await expect.poll(() => calls.length, { timeout: 45_000 }).toBeGreaterThan(0);
  expect(calls[calls.length - 1]).toEqual({ gc_contact_phone: "435-555-0199" });
});

test("an installer reads the GC's number on the GC card and is never offered the Job facts form", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  useFactsFixtures(page, FACTS_ROW);
  await page.goto(`/projects/${PROJECT_ID}`);

  const card = gcCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText("435-555-0100")).toBeVisible();
  await expect(card.getByLabel("GC phone")).toHaveCount(0);
  await expect(factsCard(page)).toHaveCount(0);
});

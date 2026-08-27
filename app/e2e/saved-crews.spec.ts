// Wave A, A5: the one e2e spec for wave A's UI surface — mocked routes, same
// idiom as daily-logs.spec.ts and calendar-memory.spec.ts. Two things:
//   1) Roster's Saved crews CRUD (A1): create, edit, delete, all through
//      save_crew/delete_crew's real RPC argument names.
//   2) Scheduling's "Plan with AI" button (A4): seeds Ask with a prompt
//      naming the visible week, as a placeholder the owner can still edit —
//      never auto-sent.
// The live model is deliberately NOT exercised here (a1-ai-scheduler-spec.md,
// A5: "Do NOT e2e the live model") — wave A2's tool-calling loop has its own
// unit coverage (anthropicTools.test.ts, schedulingTools.test.ts) with a
// mocked Anthropic; this file only proves the human-facing doors work.
import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

const CHRIS = "88e9158c-c299-4abf-86e2-4d6c1134d0be"; // profiles.json — installer, active
const DAVE = "0830d61d-3ed5-4a03-9efc-846dbfc3dce9"; // profiles.json — installer, active

/** Serves `saved_crews` from an in-memory list a test can push into, so a
 * post-save refetch (SavedCrewsSection invalidates ["savedCrews"] on
 * success) sees what was just written — same "mutate what the next GET
 * returns" idiom the fixture router itself uses nowhere else, because
 * nothing else in this repo's e2e suite round-trips a create through a list
 * yet. */
async function useSavedCrewsFixture(page: Page) {
  const rows: Array<Record<string, unknown>> = [];
  const saveCalls: Array<Record<string, unknown>> = [];
  const deleteCalls: Array<Record<string, unknown>> = [];

  await page.route("**/rest/v1/saved_crews**", (route) => json(route, rows, rows.length));

  await page.route("**/rest/v1/rpc/save_crew", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    saveCalls.push(body);
    const id = (body.p_id as string | null) ?? `new-crew-${saveCalls.length}`;
    const row = {
      id,
      name: body.p_name,
      member_ids: body.p_members,
      note: body.p_note,
      created_by: "e2e",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const idx = rows.findIndex((r) => r.id === id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    await json(route, row);
  });

  await page.route("**/rest/v1/rpc/delete_crew", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    deleteCalls.push(body);
    const idx = rows.findIndex((r) => r.id === body.p_id);
    if (idx >= 0) rows.splice(idx, 1);
    await json(route, null);
  });

  return { saveCalls, deleteCalls };
}

test("a supervisor builds, edits, and deletes a saved crew on the Roster", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const { saveCalls, deleteCalls } = await useSavedCrewsFixture(page);

  await page.goto("/crew");
  await expect(page.getByRole("heading", { name: "Saved crews" })).toBeVisible();
  await expect(page.getByText("No saved crews yet — build one below.")).toBeVisible();

  // -- Create ---------------------------------------------------------------
  await page.getByRole("button", { name: "+ New crew" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await dialog.getByLabel("Name").fill("Sand Hollow Crew");
  const save = dialog.getByRole("button", { name: "Save" });
  await expect(save).toBeDisabled(); // fewer than MIN_MEMBERS (2) picked

  await dialog.getByRole("button", { name: "Chris" }).click();
  await dialog.getByRole("button", { name: "Dave" }).click();
  await expect(dialog.getByText("2 picked")).toBeVisible();
  await expect(save).toBeEnabled();

  await dialog.getByLabel("Note").fill("Keeps Sand Hollow crews together");
  await save.click();

  await expect.poll(() => saveCalls.length).toBe(1);
  expect(saveCalls[0]).toEqual({
    p_id: null,
    p_name: "Sand Hollow Crew",
    p_members: [CHRIS, DAVE],
    p_note: "Keeps Sand Hollow crews together",
  });
  await expect(dialog).toBeHidden();
  // exact: true — a substring match would also hit the note below
  // ("Keeps Sand Hollow crews together" contains "Sand Hollow Crew").
  await expect(page.getByText("Sand Hollow Crew", { exact: true })).toBeVisible();
  await expect(page.getByText("Chris, Dave")).toBeVisible();

  // -- Edit -------------------------------------------------------------
  const card = page.locator(".detail-card").filter({ hasText: "Sand Hollow Crew" });
  await card.getByRole("button", { name: "Edit" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveValue("Sand Hollow Crew");

  await dialog.getByLabel("Name").fill("Sand Hollow Crew (renamed)");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect.poll(() => saveCalls.length).toBe(2);
  expect(saveCalls[1]).toMatchObject({ p_id: "new-crew-1", p_name: "Sand Hollow Crew (renamed)" });
  await expect(page.getByText("Sand Hollow Crew (renamed)")).toBeVisible();

  // -- Delete -------------------------------------------------------------
  page.once("dialog", (d) => d.accept()); // window.confirm before delete
  const renamedCard = page.locator(".detail-card").filter({ hasText: "Sand Hollow Crew (renamed)" });
  await renamedCard.getByRole("button", { name: "Delete" }).click();

  await expect.poll(() => deleteCalls.length).toBe(1);
  expect(deleteCalls[0]).toEqual({ p_id: "new-crew-1" });
  await expect(page.getByText("No saved crews yet — build one below.")).toBeVisible();
});

test("a foreman sees saved crews read-only — no New/Edit/Delete controls", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await page.route("**/rest/v1/saved_crews**", (route) =>
    json(
      route,
      [{ id: "crew-1", name: "Team 1", member_ids: [CHRIS, DAVE], note: null }],
      1,
    ),
  );

  await page.goto("/crew");
  await expect(page.getByRole("heading", { name: "Saved crews" })).toBeVisible();
  await expect(page.getByText("Team 1")).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New crew" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("Plan with AI seeds Ask with the visible week — a placeholder, not sent", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });

  await page.goto("/scheduling");
  const planButton = page.getByRole("button", { name: "Plan with AI" });
  await expect(planButton).toBeVisible();
  await planButton.click();

  await expect(page).toHaveURL(/\/ask$/);
  const input = page.getByPlaceholder("Ask about a window, a term, or how-to…");
  await expect(input).toHaveValue(/^Plan the week of .+ — here's what I want: $/);

  // A placeholder the owner edits, never auto-sent: no bubble beyond the
  // page's own opening greeting.
  await expect(page.locator(".ask-bubble")).toHaveCount(1);
});

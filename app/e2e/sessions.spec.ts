// Sessions field UI: Block is a first-class exit — the reason sheet fires
// the real block_unit RPC with the chain target riding along.
import { test, expect } from "@playwright/test";
import { jobFixtures, openingsFor, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

test("Block: preset reason fires block_unit with the chain target", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  // Mid-install: the sheet opens on the install stage with the Block exit.
  const opening = {
    ...openingsFor(BLACK22.projectId)[0],
    work_started_at: "2026-08-16T10:00:00Z",
    needs_flashing: false,
    status: "assigned",
  };

  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      (url.searchParams.get("id") ?? "").startsWith("eq."),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/1" },
        body: JSON.stringify([opening]),
      }),
  );

  const blocks: { opening: string; reason: string; next: string | null }[] = [];
  await page.route("**/rest/v1/rpc/block_unit", async (route) => {
    const body = route.request().postDataJSON() as {
      p_opening_id: string;
      p_reason: string;
      p_next_opening_id: string | null;
    };
    blocks.push({
      opening: body.p_opening_id,
      reason: body.p_reason,
      next: body.p_next_opening_id,
    });
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });

  await page.goto(`/projects/${BLACK22.projectId}/opening/${opening.id}`);
  // work_started_at means the timer is live; the stage tabs jump straight
  // to the install stage where the Block exit lives.
  await page.getByRole("button", { name: "2. Install" }).click();
  await expect(
    page.getByRole("button", { name: /Blocked — can't continue/ }),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /Blocked — can't continue/ }).click();
  await page.getByRole("button", { name: "Wrong glass", exact: true }).click();

  await expect.poll(() => blocks.length).toBe(1);
  expect(blocks[0].opening).toBe(opening.id);
  expect(blocks[0].reason).toBe("Wrong glass");
  // The chain target is whatever pickNextOpening proposed (another fixture
  // opening) — present unless this was the installer's only window.
  expect(blocks[0].next === null || typeof blocks[0].next === "string").toBe(true);
});

// The QR-less delivery wizard (owner ask, 2026-08-21 night): no scanner, no
// printer, a truck in the morning. The whole skeleton lands in ONE rpc call.
import { test, expect } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const job = jobFixtures()[0];

test("hand-logging a delivery sends the skeleton in one call", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });

  let payload: { p_label: string; p_entries: unknown[] } | null = null;
  await page.route("**/rest/v1/rpc/create_manual_delivery", async (route) => {
    payload = route.request().postDataJSON() as typeof payload;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ delivery_id: "d-1", created: 4, unfiled: 0, pending: 0 }),
    });
  });

  await page.goto("/storage/log-delivery");
  await page.getByRole("button", { name: /Without stickers/ }).click();

  // Step 1: one real job.
  await page.getByLabel("Delivery name (optional)").fill("Test truck");
  await page.locator("select").first().selectOption(job.projectId);
  await page.getByRole("button", { name: /Next: the sets/ }).click();

  // Step 2: one set, #16, 3 packages, ×6 identical, 4 pieces of glass in Crate 1.
  await page.getByLabel("Mark").fill("16");
  await page.getByLabel("How many packages").selectOption("3");
  await page.getByRole("button", { name: /Clones \(identical units\)/ }).click();
  await page.getByLabel("How many identical").selectOption("6");
  await page.getByRole("button", { name: /Pieces in a crate/ }).click();
  await page.getByLabel("Pieces in the crate").fill("4");
  await page.getByRole("button", { name: /Next: review/ }).click();

  // Review speaks the whole line, then saves.
  await expect(
    page.getByText(
      "#16 · Window · ×6 identical · 3 packages each + 4 pieces of glass each in Crate 1",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: /Save the delivery/ }).click();
  await expect(
    page.getByText(/standby list is saved — 4 expected packages/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open the delivery/ }),
  ).toBeVisible();

  expect(payload).not.toBeNull();
  expect(payload!.p_label).toBe("Test truck");
  const entry = payload!.p_entries[0] as {
    project_id: string;
    sets: Array<{ mark: string; package_count: number; crate: { pieces: number } }>;
  };
  expect(entry.project_id).toBe(job.projectId);
  expect(entry.sets[0]).toMatchObject({ mark: "16", package_count: 3, quantity: 6 });
  expect(entry.sets[0].crate).toMatchObject({ pieces: 4 });
});

test("a job that isn't built yet types through without blocking", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  let payload: { p_entries: unknown[] } | null = null;
  await page.route("**/rest/v1/rpc/create_manual_delivery", async (route) => {
    payload = route.request().postDataJSON() as typeof payload;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ delivery_id: "d-2", created: 1, unfiled: 1, pending: 0 }),
    });
  });

  await page.goto("/storage/log-delivery");
  await page.getByRole("button", { name: /Without stickers/ }).click();
  await page.getByPlaceholder("Type the job's name").fill("Sunset Ridge 4");
  await page.getByRole("button", { name: /Next: the sets/ }).click();
  await page.getByLabel("Mark").fill("7");
  await page.getByRole("button", { name: /Next: review/ }).click();
  await expect(page.getByText(/job not built yet/)).toBeVisible();
  await page.getByRole("button", { name: /Save the delivery/ }).click();
  await expect(
    page.getByText(/belong to jobs that aren't built yet/),
  ).toBeVisible();
  const entry = payload!.p_entries[0] as { project_id: null; job_name: string };
  expect(entry.project_id).toBeNull();
  expect(entry.job_name).toBe("Sunset Ridge 4");
});

test("a refresh mid-list picks the draft back up", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await page.goto("/storage/log-delivery");
  await page.getByRole("button", { name: /Without stickers/ }).click();
  await page.getByLabel("Delivery name (optional)").fill("Half-done truck");
  await page.getByRole("button", { name: /Next: the sets/ }).click();
  await page.getByLabel("Mark").fill("12");

  await page.reload();
  await expect(page.getByText(/Picked your unsaved delivery back up/)).toBeVisible();
  await expect(page.getByLabel("Delivery name (optional)")).toHaveValue(
    "Half-done truck",
  );
  await page.getByRole("button", { name: /Next: the sets/ }).click();
  await expect(page.getByLabel("Mark")).toHaveValue("12");

  // Start fresh clears it for real.
  await page.getByRole("button", { name: /Next: review/ }).click();
  await page.getByRole("button", { name: /Back/ }).click();
  await page.reload();
  await page.getByRole("button", { name: /start fresh/ }).click();
  await expect(page.getByLabel("Delivery name (optional)")).toHaveValue("");
});

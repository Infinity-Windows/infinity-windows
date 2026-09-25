// Prep time (crew redesign K1.5): one tap from Work, a reason, and the same
// record Current Work's idle timer always wrote — the stored stage is still
// "Idle time"; only the words on screen moved, in both languages.

import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { dayISO, hideWrongProjectBanner, stubGeolocationDenied } from "./support/specHelpers";
import { morningFixtures, OAKRIDGE } from "./support/release1Fixtures";

test.use({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });

// Prep time waits for today's toolbox talk exactly like unit work (K1.3, the
// owner's answer of 2026-09-24): locked in words on the clock with the talk
// owed, and the server's refusal (_prep_time_gate, 20261031000000) said in
// plain words when the phone's read was stale.
test("K1.3: on the clock with the talk owed, Prep time is locked in words — like unit work", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  // Clocked in unsigned: the order the paid-time rule allows from the owner's date.
  await morningFixtures(page, { signed: false, openShift: true, paidTimeFrom: dayISO(0) });
  await page.goto("/");
  const prep = page.getByTestId("ws-quick-prep");
  await expect(prep).toHaveAttribute("data-locked", "true");
  await prep.click();
  await expect(page.getByRole("dialog", { name: "Prep time" })).toHaveCount(0);
  await expect(page.getByText("Sign today's toolbox talk to start prep time.")).toBeVisible();
  // The card under the clock says what the signature unlocks: both.
  await expect(page.getByTestId("ws-finish-talk")).toContainText("Sign today's talk to unlock unit work and prep time.");
});

test("K1.3: a prep start Forge refuses for the signature is said in plain words, and the next tap is not jammed", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  // The phone's last read says signed, so the sheet opens; the server knows
  // the record better, and answers as PostgREST hands it over.
  await morningFixtures(page, { signed: true, openShift: true });
  await page.route((url) => /\/rest\/v1\/rpc\/custom_work_command(\?|$)/.test(url.href), (r) =>
    r.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ code: "P0001", message: "Sign today's toolbox talk before starting work.", details: null, hint: null }),
    }),
  );
  await page.goto("/");
  await page.getByTestId("ws-quick-prep").click();
  const sheet = page.getByRole("dialog", { name: "Prep time" });
  await sheet.getByRole("button", { name: "Hauling", exact: true }).click();
  await page.getByTestId("ws-prep-start").click();
  await expect(page.locator(".toast-error")).toContainText("Forge won't start prep time until today's toolbox talk is signed. Sign it under Finish your toolbox talk");
  await expect(sheet).toHaveCount(0);
  // The refused request is not kept for review (nothing was written, and a
  // retry after signing would carry the unsigned tap's time): the next tap
  // opens the sheet again instead of finding the phone's queue jammed.
  await page.getByTestId("ws-quick-prep").click();
  await expect(page.getByRole("dialog", { name: "Prep time" })).toBeVisible();
});

test("Prep time → Hauling → Start records a non-unit session with the reason, and shows it running", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const world = await morningFixtures(page, { signed: true, openShift: true });
  await page.goto("/");
  await page.getByTestId("ws-quick-prep").click();
  const sheet = page.getByRole("dialog", { name: "Prep time" });
  await expect(sheet).toBeVisible();
  for (const reason of ["Gathering", "Hauling", "Setup", "Errand", "Cleanup", "Other"]) {
    await expect(sheet.getByRole("button", { name: reason, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId("ws-prep-start")).toBeDisabled();
  await sheet.getByRole("button", { name: "Hauling", exact: true }).click();
  await page.getByTestId("ws-prep-start").click();
  await expect.poll(() => world.workCommands.length).toBe(1);
  const cmd = world.workCommands[0] as { p_action: string; p_data: Record<string, unknown> };
  expect(cmd.p_action).toBe("start");
  expect(cmd.p_data.unit_id).toBeNull();
  expect(cmd.p_data.stage).toBe("Idle time");
  expect(cmd.p_data.description).toBe("Hauling");
  expect(cmd.p_data.project_id).toBe(OAKRIDGE);
  await expect(sheet).toHaveCount(0);
});

test("off the clock the button says to start your day rather than opening a dead end", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true });
  await page.goto("/");
  await page.getByTestId("ws-quick-prep").click();
  await expect(page.getByRole("dialog", { name: "Prep time" })).toHaveCount(0);
  await expect(page.getByText("Start your day to record prep time.")).toBeVisible();
});

test("Spanish: one term, Tiempo de preparación, on Work, on the sheet and on the classic Current Work", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new", language: "es" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  await morningFixtures(page, { signed: true, openShift: true });
  await page.goto("/");
  await page.getByTestId("ws-quick-prep").click();
  const sheet = page.getByRole("dialog", { name: "Tiempo de preparación" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Acarreando");
  await expect(page.locator("body")).not.toContainText("Tiempo indirecto");
  await expect(page.locator("body")).not.toContainText("Tiempo entre unidades");
  await sheet.getByRole("button", { name: "Cancelar" }).click();
  await page.goto("/current-work");
  await expect(page.getByRole("button", { name: "Tiempo de preparación" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Idle time");
});

// The view-as ceiling (owner bug report, 2026-09-01): "the only roles people
// should be able to preview is their same rank and below, that's it." A
// supervisor could open the picker and tap Owner, and effectiveRole rendered
// the owner UI for them — a real hole, since effectiveRole is what every
// route guard (RequireRole, nav.ts's canAccess) gates on, and this app's
// permission-mirror pattern means an owner-only screen rendered for a
// supervisor surfaces owner-level information, not just a cosmetic mislabel.
//
// Two layers, proven here: the PICKER never offers a role above your own
// (nothing to tap), and effectiveRole CLAMPS even if a bad value reaches
// state anyway (a stale sessionStorage value, or a direct storage edit).
// See src/lib/viewAsRoleContext.test.ts for the clamp's own unit coverage —
// this spec is the integration proof that Layout's picker and the real route
// guards agree with it end to end.
import { test, expect } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

test("a supervisor's view-as picker never offers Owner (same rank and below only)", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });

  // /receipts is a real supervisor+ route (receipts.spec.ts proves the
  // gate both ways) — reachable without any extra fixture stubbing, and
  // Layout renders around it exactly like any other page.
  await page.goto("/receipts");
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();

  await page.getByRole("button", { name: "Open menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog.getByText("View as role (preview)")).toBeVisible();

  const options = dialog.locator(".view-as-options");
  await expect(options.getByRole("button", { name: "Supervisor" })).toBeVisible();
  await expect(options.getByRole("button", { name: "Foreman" })).toBeVisible();
  await expect(options.getByRole("button", { name: "Installer" })).toBeVisible();
  // The whole point: a supervisor outranks foreman/installer but not owner,
  // so Owner must not even be a button to tap.
  await expect(options.getByRole("button", { name: "Owner" })).toHaveCount(0);
});

test("a forged stored owner-preview still renders the supervisor's own UI", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  // A stale value left over from before this fix, or a direct sessionStorage
  // edit in devtools — either way the real signed-in user is a supervisor,
  // and the app must never trust a stored role above that rank. Set before
  // the app boots, the same way useSupabaseFixtures seeds the auth session.
  await page.addInitScript(() => {
    window.sessionStorage.setItem("infinity.viewAsRole", "owner");
  });

  // The owner-only route stays locked — RequireRole gates on effectiveRole,
  // which must clamp the forged value back to "supervisor" rather than let
  // it through, or this owner-only dashboard would leak straight to a
  // supervisor login.
  await page.goto("/ai-spend");
  await expect(page.getByText("Not available for your role")).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI spend" })).toHaveCount(0);

  // ...while the supervisor's own reachable route renders faithfully, with
  // no trace of the forged "owner" anywhere in the UI — no banner claiming a
  // preview that was never actually honored.
  await page.goto("/receipts");
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
  await expect(page.getByText("Viewing as", { exact: false })).toHaveCount(0);
});

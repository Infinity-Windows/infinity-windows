import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

test("supervisor can switch among the two reporting tabs", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await page.goto("/data");
  const tabs = page.getByRole("tablist", { name: "Data comparison views" });
  await expect(tabs.getByRole("tab")).toHaveText(["Job Performance", "Work Dashboard"]);
  await expect(tabs.getByRole("tab", { name: "Job Performance" })).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "Work Dashboard" }).click();
  await expect(page.getByRole("tabpanel", { name: "Work Dashboard" })).toBeVisible();

});

test("Spanish Data labels come from the owner profile language", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner", language: "es", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await page.goto("/data");
  await expect(page.getByRole("tablist", { name: "Vistas de Data" }).getByRole("tab"))
    .toHaveText(["Rendimiento de obras", "Panel de trabajo"]);
});

for (const role of ["installer", "foreman"] as const) {
  test(`${role} cannot see the Data route`, async ({ page }) => {
    await useSupabaseFixtures(page, { role, uiDesign: "new" });
    await hideWrongProjectBanner(page);
    await page.goto("/data");
    await expect(page.getByRole("heading", { name: "Not available for your role" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Data comparison views" })).toHaveCount(0);
  });
}

test("owner role preview cannot see the Data route", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await page.goto("/data");
  await page.getByRole("tab", { name: "Job Performance" }).waitFor();
  await page.evaluate(() => sessionStorage.setItem("infinity.viewAsRole", "installer"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Not available for your role" })).toBeVisible();
});

test("a partner is redirected away from the Data route", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer", uiDesign: "new" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/rpc/is_partner_user", route => json(route, true, null));
  await page.goto("/data");
  await expect(page).toHaveURL(/\/stg\/?$/);
});

test("Classic /data remains the existing DataHub", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner", uiDesign: "classic" });
  await hideWrongProjectBanner(page);
  await page.goto("/data");
  await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Data comparison views" })).toHaveCount(0);
});

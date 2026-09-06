// /diagnostics answers "it didn't save" with facts instead of a shrug.
//
// Fixture-backed: no login, no network. What is proven is the door and the
// shape: Settings links to it, every section is there with a heading a
// person can read, the queues list the kinds of write the phone holds, and
// "Copy report" exists. The wording of the copied text is unit-tested in
// lib/offline/diagnosticsReport.test.ts.
import { expect, test } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

test("Settings opens Diagnostics, and the page shows the phone's state", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await page.goto("/settings");
  await page.getByTestId("open-diagnostics").click();
  await expect(page).toHaveURL(/\/diagnostics$/);

  const root = page.getByTestId("diagnostics-page");
  await expect(root.getByRole("heading", { level: 1 })).toHaveText(/Diagnostics|Diagnóstico/);
  await expect(page.getByTestId("diag-connection")).toContainText(/Online|Weak signal|No signal|En línea|Señal débil|Sin señal/);
  await expect(page.getByTestId("diag-queues")).toContainText(/Clock/);
  await expect(page.getByTestId("diag-queues")).toContainText(/Installs/);
  await expect(page.getByTestId("diag-saved")).toContainText(/None yet|Ninguno/);
  await expect(page.getByTestId("diag-events")).toBeVisible();
  await expect(page.getByTestId("diag-copy")).toHaveText(/Copy report|Copiar informe/);
});

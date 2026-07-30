import { test } from "@playwright/test";

const EMAIL = process.env.TEST_FOREMAN_EMAIL ?? "";
const PASSWORD = process.env.TEST_FOREMAN_PASSWORD ?? "";
const OUT = "/tmp/iw-foreman-debug";

test("what the map actually shows", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("infinity-perm-wizard-choice", "completed");
    window.localStorage.setItem(
      "infinity:dismissed-tips",
      JSON.stringify(["home", "home_installer", "my_work", "projects", "photos", "chat", "schedule", "travel"]),
    );
  });
  await page.goto("/");
  const email = page.locator('input[type="email"]');
  if (!(await email.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
  }
  await email.fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await page.waitForTimeout(4000);

  await page.goto("/projects/7c55982f-7c88-45d6-b165-dd1ac78602ec/map");
  await page.waitForTimeout(25000);

  for (const [name, view] of [["outline", "Building outline"], ["building", "Original plan"]] as const) {
    await page.getByRole("button", { name: view, exact: true }).click().catch(() => {});
    await page.waitForTimeout(8000);
    const counts = await page.evaluate(() => ({
      dots: document.querySelectorAll(".plan-dot").length,
      walls: document.querySelectorAll("[data-wall-opening]").length,
      withDots: document.querySelectorAll(".plan-map--with-dots").length,
      cartoon: document.querySelectorAll(".cartoon-sheet").length,
      status: document.querySelector(".cartoon-sheet__status")?.textContent ?? "",
      activeFilter: document.querySelector(".chip.active")?.textContent ?? "",
      filters: [...document.querySelectorAll('[aria-label="Filter openings"] button')].map(
        (b) => `${b.textContent}${b.className.includes("active") ? "*" : ""}`,
      ),
    }));
    console.log(`VIEW ${name}: ${JSON.stringify(counts)}`);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  }
});

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Account = { email: string; password: string; role: string; display_name: string };
const accounts = JSON.parse(readFileSync(join(homedir(), ".config/forge-workshop/accounts.json"), "utf8")) as Account[];

async function login(page: Page, account: Account) {
  const productionRequests: string[] = [];
  page.on("request", request => {
    const host = new URL(request.url()).hostname;
    if (host.includes("czprjcskmzzagdztqonm") || host.includes("jvsyhtarnvmdilsgksdi") || host === "app.forgewd.com") productionRequests.push(host);
  });
  page.on("websocket", socket => {
    const host = new URL(socket.url()).hostname;
    if (host.includes("czprjcskmzzagdztqonm") || host.includes("jvsyhtarnvmdilsgksdi") || host === "app.forgewd.com") productionRequests.push(host);
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "FORGE WORKSHOP" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(account.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work", exact: true }).or(page.locator(".steel-home"))).toBeVisible();
  for (let attempt=0; attempt<3; attempt++) {
    const language = page.getByRole("dialog", { name: "Choose your language", exact: true });
    if (await language.isVisible()) await language.getByRole("button", { name: "English", exact: true }).click();
    const skip = page.getByRole("button", { name: "Skip for now", exact: true });
    if (await skip.isVisible()) await skip.click();
    const got = page.getByRole("button", { name: "Got it", exact: true });
    if (await got.isVisible()) await got.click();
  }
  if (await page.locator(".steel-home").isVisible()) {
    await page.getByRole("link", { name: "Open Work", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  }
  expect(productionRequests).toEqual([]);
  return productionRequests;
}

for (const account of accounts) {
  test(`real workshop ${account.display_name} can sign in and see the simple workshop start`, async ({ page }) => {
    const requests = await login(page,account);
    await expect(page.getByRole("button", { name: "Clock in", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clock in", exact: true })).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Today's toolbox talk", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your saved units", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Prep time", exact: true })).toHaveCount(0);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const bar = page.getByRole("navigation", { name: "Main", exact: true });
      await expect(bar).toBeVisible();
      expect(await bar.evaluate(el => getComputedStyle(el).position)).toBe("fixed");
    }
    expect(requests).toEqual([]);
  });
}

test("steel phone preview runs the actual signed-in app at 390 and 320 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const requests = await login(page, accounts.find(a => a.role === "owner")!);
  await page.evaluate(() => localStorage.setItem("infinity.display-mode", "desktop"));
  await page.getByRole("link", { name: "Phone view", exact: true }).click();
  const phone = page.frameLocator('iframe[title="Forge Workshop phone app"]');
  await expect(phone.getByRole("status").filter({ hasText: "FORGE WORKSHOP" })).toBeVisible();
  await expect(phone.locator(".steel-home")).toBeVisible();
  await expect(phone.getByRole("link", { name: "Phone view", exact: true })).toHaveCount(0);
  for (const width of [390, 320]) {
    await page.getByRole("combobox", { name: "Phone width", exact: true }).selectOption(String(width));
    await expect.poll(async () => phone.locator("html").evaluate(() => window.innerWidth)).toBe(width);
    expect(await phone.locator("html").evaluate(el => el.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await phone.getByRole("navigation", { name: "Main", exact: true }).getByRole("link", { name: "Work", exact: true }).click();
  await expect(phone.getByRole("button", { name: "Clock in", exact: true })).toBeVisible();
  // SPA links remove the hint from the URL. Reload must keep this frame in
  // phone layout while the outer app's pinned desktop setting remains intact.
  await phone.locator("html").evaluate(() => window.location.reload());
  await expect(phone.getByRole("button", { name: "Clock in", exact: true })).toBeVisible();
  await expect(phone.getByRole("navigation", { name: "Main", exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("infinity.display-mode"))).toBe("desktop");
  expect(await page.evaluate(() => localStorage.getItem("infinity.display-mode"))).toBe("desktop");
  await page.getByRole("link", { name: "Back to app", exact: true }).click();
  await expect(page.locator(".steel-home")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Primary", exact: true })).toBeVisible();
  expect(requests).toEqual([]);
});

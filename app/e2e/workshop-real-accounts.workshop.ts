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
    if (host.includes("czprjcskmzzagdztqonm") || host.includes("jvsybohevtpadtkoxgyh") || host === "app.forgewd.com") productionRequests.push(host);
  });
  page.on("websocket", socket => {
    const host = new URL(socket.url()).hostname;
    if (host.includes("czprjcskmzzagdztqonm") || host.includes("jvsybohevtpadtkoxgyh") || host === "app.forgewd.com") productionRequests.push(host);
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "FORGE WORKSHOP" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(account.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  for (let attempt=0; attempt<3; attempt++) {
    const language = page.getByRole("dialog", { name: "Choose your language", exact: true });
    if (await language.isVisible()) await language.getByRole("button", { name: "English", exact: true }).click();
    const skip = page.getByRole("button", { name: "Skip for now", exact: true });
    if (await skip.isVisible()) await skip.click();
    const got = page.getByRole("button", { name: "Got it", exact: true });
    if (await got.isVisible()) await got.click();
  }
  expect(productionRequests).toEqual([]);
  return productionRequests;
}

for (const account of accounts) {
  test(`real workshop ${account.display_name} can sign in and see invented work`, async ({ page }) => {
    const requests = await login(page,account);
    await expect(page.getByTestId("ws-clock")).toBeVisible();
    await expect(page.getByTestId("ws-clock")).toContainText(/Start day|Clocked in|On break/);
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await expect(page.getByRole("button", { name: /^WKDESERT Workshop — Desert Windows(?: Data)?$/ })).toBeVisible();
    expect(requests).toEqual([]);
  });
}

test("real installer signs a practice talk and starts a saved job clock", async ({ page }) => {
  const account=accounts.find(a=>a.email.startsWith("installer-one@"))!;
  const requests=await login(page,account);
  const clock=page.getByTestId("ws-clock");
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await page.getByRole("button", { name: /^WKDESERT Workshop — Desert Windows(?: Data)?$/ }).click();
  await expect(clock).toContainText("WKDESERT");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Start day", exact: true }).click();
  const acknowledgment = clock.getByText("I read and understood today's talk");
  // A practice signature already recorded today must remain intact on rerun.
  await expect(clock).toContainText(/I read and understood|Clocked in/);
  if (await acknowledgment.isVisible()) {
  await acknowledgment.click();
  await clock.getByRole("textbox", { name: "Full name", exact: true }).fill(account.display_name);
  const canvas=clock.locator("canvas.sig-canvas");
  await canvas.scrollIntoViewIfNeeded();
  const box=(await canvas.boundingBox())!;
  await page.mouse.move(box.x+20,box.y+box.height/2);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width-20,box.y+box.height/2+10,{steps:8});
  await page.mouse.up();
  await clock.getByRole("button", { name: "Sign today's talk", exact: true }).click();
  }
  await expect(clock).toContainText("Clocked in");
  await page.reload();
  await expect(clock).toContainText("Clocked in");
  expect(requests).toEqual([]);
});

test("real installer takes a break, resumes and clocks out with a saved result", async ({ page }) => {
  const account=accounts.find(a=>a.email.startsWith("installer-one@"))!;
  const requests=await login(page,account);
  const clock=page.getByTestId("ws-clock");
  await expect(clock).toContainText("Clocked in");
  await clock.getByRole("button",{name:"Break",exact:true}).click();
  const sheet=page.locator(".clock-sheet");
  await sheet.getByRole("button",{name:"Go on break",exact:true}).click();
  await sheet.getByRole("button",{name:"Rest",exact:true}).click();
  await expect(clock).toContainText("On break");
  await sheet.getByRole("button",{name:"Resume work",exact:true}).click();
  await expect(clock).toContainText("Clocked in");
  await sheet.getByRole("button",{name:"Clock out",exact:true}).click();
  await expect(clock.getByRole("button",{name:"Start day",exact:true})).toBeVisible();
  await page.reload();
  await expect(clock.getByRole("button",{name:"Start day",exact:true})).toBeVisible();
  expect(requests).toEqual([]);
});

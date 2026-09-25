// Your own PIN, set from Settings (2026-09-25).
//
// Setting a PIN used to live on the Roster, which has been supervisor-only
// since #610, so an installer could not set, change or remove one at all. It
// is on Settings now, where every role can reach it. This drives it as an
// installer, against the lock that has to honour it:
//   - Settings shows the setting, and Save PIN sends the four digits typed;
//   - the lock then asks for that PIN: at once, because this tab has never had
//     the right PIN typed into it (#651's rule, the same as it always was on
//     the Roster), and again after a reload;
//   - the right PIN opens the app back on Settings, which now says a PIN is set;
//   - Clear removes it, and the next launch opens with no PIN pad.
//
// A launch is a reload with this tab's storage cleared: the lock remembers an
// unlock for the rest of the tab's life there (lib/pinGate.ts), and a closed
// and reopened app does not keep it. pin-gate-offline.spec.ts says more.
import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner } from "./support/specHelpers";
import { pinStatusIs, typePin, usePinCheck } from "./support/pinFixtures";

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const LOCK = "Enter your 4-digit PIN";

/**
 * The server's side of set_my_pin: keep what was sent, and from then on answer
 * the lock's two questions the way the real server would. Each answer is
 * registered before the save is answered, so the refetch that follows a save
 * already hears the new one.
 */
async function usePinSaves(page: Page): Promise<string[]> {
  const sent: string[] = [];
  await page.route("**/rest/v1/rpc/set_my_pin", async (route) => {
    const pin = (route.request().postDataJSON() as { p_pin?: string } | null)?.p_pin ?? "";
    sent.push(pin);
    await pinStatusIs(page, pin !== "");
    if (pin) await usePinCheck(page, pin);
    return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });
  return sent;
}

/** Close the app and open it again: this tab's unlock goes, the phone's copy stays. */
async function relaunch(page: Page) {
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
}

test("an installer sets a PIN in Settings, the lock asks for it, and Clear removes it", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  const sent = await usePinSaves(page);
  await page.goto("/settings");

  const settings = page.getByRole("heading", { name: "Settings", level: 1 });
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "PIN lock" }) });
  await expect(settings).toBeVisible();
  await card.getByLabel("Your quick-unlock PIN (none)").fill("4821");
  await card.getByRole("button", { name: "Save PIN" }).click();

  await expect.poll(() => sent).toEqual(["4821"]);
  // At once: a first PIN takes effect the moment the server has it.
  await expect(page.getByText(LOCK)).toBeVisible();
  await expect(settings).toHaveCount(0);

  // And after a reload.
  await page.reload();
  await expect(page.getByText(LOCK)).toBeVisible();
  await expect(settings).toHaveCount(0);

  // The right PIN opens the app, back where the person was.
  await typePin(page, "4821");
  await expect(settings).toBeVisible();
  await expect(card.getByLabel("Your quick-unlock PIN (set)")).toBeVisible();

  // Clear removes it, and the next launch goes straight in.
  await card.getByRole("button", { name: "Clear" }).click();
  await expect.poll(() => sent).toEqual(["4821", ""]);
  await expect(card.getByLabel("Your quick-unlock PIN (none)")).toBeVisible();
  await relaunch(page);
  await expect(settings).toBeVisible();
  await expect(page.getByText(LOCK)).toHaveCount(0);
});

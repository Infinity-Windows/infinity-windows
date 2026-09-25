// The device lock's side of the server, answered in the browser, and the PIN
// pad typed the way a person types it.
//
// Moved here from pin-gate-offline.spec.ts on 2026-09-25, word for word, when
// a second spec (pin-in-settings.spec.ts) needed the same three: one copy, so
// a fix made for one spec is made for both (specHelpers.ts says why that
// matters). Register them after useSupabaseFixtures: Playwright answers a
// request with the route added most recently, so these win over its router,
// and a later call wins over an earlier one.

import type { Page } from "@playwright/test";

/** Answer the PIN-status question the way this account would. */
export async function pinStatusIs(page: Page, hasPin: boolean) {
  await page.route("**/rest/v1/rpc/my_pin_status", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hasPin) }),
  );
}

/** The server's check, for an account whose PIN is `pin`. */
export async function usePinCheck(page: Page, pin: string) {
  await page.route("**/rest/v1/rpc/check_my_pin", (route) => {
    const body = route.request().postDataJSON() as { p_pin?: string } | null;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body?.p_pin === pin),
    });
  });
}

export async function typePin(page: Page, digits: string) {
  for (const digit of digits) {
    await page.locator(".pin-pad").getByRole("button", { name: digit, exact: true }).click();
  }
}

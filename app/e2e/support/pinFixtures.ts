// The PIN pad, typed the way a person types it.
//
// Moved here word for word from pin-gate-offline.spec.ts on 2026-09-25, when
// pin-in-settings.spec.ts needed it too: one copy, so a fix made for one spec
// is made for both (specHelpers.ts says why that matters).

import type { Page } from "@playwright/test";

export async function typePin(page: Page, digits: string) {
  for (const digit of digits) {
    await page.locator(".pin-pad").getByRole("button", { name: digit, exact: true }).click();
  }
}

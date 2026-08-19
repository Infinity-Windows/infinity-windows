// The password-reset landing (owner report, 2026-08-18): the emailed link
// used to point at the domain root — a 404 — and even the right URL had no
// set-new-password screen. This drives the fixed landing end to end: boot
// from a recovery hash, see the one-job screen, save, land in the app.
import { test, expect } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

test("a recovery landing asks for the new password, saves it, then opens the app", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });

  const saved: { password?: string }[] = [];
  // Newest-first route registration wins: capture the PUT the save fires.
  await page.route("**/auth/v1/user**", async (route) => {
    if (route.request().method() === "PUT") {
      saved.push(route.request().postDataJSON() as { password?: string });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    }
    return route.fallback();
  });

  // The exact shape a reset email lands with (tokens elided — the seeded
  // session stands in for a verified link).
  await page.goto("/#type=recovery");

  await expect(page.getByText("Set a new password")).toBeVisible({
    timeout: 30_000,
  });

  // Client-side guard speaks plainly before anything is sent.
  await page.getByPlaceholder("New password", { exact: true }).fill("short");
  await page.getByPlaceholder("Same password again").fill("short");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.getByText("Use at least 8 characters.")).toBeVisible();
  expect(saved).toHaveLength(0);

  await page.getByPlaceholder("New password", { exact: true }).fill("brand-new-pass-1");
  await page.getByPlaceholder("Same password again").fill("brand-new-pass-1");
  await page.getByRole("button", { name: "Save new password" }).click();

  await expect(page.getByText("New password saved")).toBeVisible();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].password).toBe("brand-new-pass-1");

  // "Open the app" drops the spent hash and lands on the normal app.
  await page.getByRole("button", { name: "Open the app" }).click();
  await expect(page.getByText("Set a new password")).not.toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
});

test("an expired reset link lands on sign-in with a plain sentence, not an error page", async ({
  page,
}) => {
  // No fixtures on purpose: an expired link arrives with NO session. Just
  // keep the app off the network while it boots signed out.
  await page.route("**/auth/v1/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("**/rest/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.goto(
    "/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
  );
  await expect(
    page.getByText("That reset link has expired — send yourself a fresh one below."),
  ).toBeVisible({ timeout: 30_000 });
});

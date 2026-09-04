// Wave Z — the money doors, on the real screens.
//
// What this proves against the app rather than a unit test:
//   Z1  the role floor on /costing is unchanged for a foreman with no grant,
//       and OPENS for the same foreman once the owner has ticked "Sees costs";
//       the Roster's two checkboxes exist for an owner and for nobody else,
//       and ticking one sends set_profile_grants and nothing else.
//   Z4  the receipt capture sheet's cost-code picker sends the code through
//       set_receipt_cost_code, alongside the answer it already sent.
//   Z5  the bank import's mapping step: a file with nobody's idea of standard
//       column names is read, the guess is offered, a human confirms, and the
//       rows that reach import_bank_transactions carry mapped values — with the
//       row whose amount cannot be read left out rather than imported as zero.
//
// House style, same as receipts.spec.ts: mocked routes, real UI, assert the
// CAPTURED RPC PAYLOAD a tap actually sends.

import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** Every money table answers empty, so the screens render their real chrome
 * without a fixture pretending the company has books. */
async function useMoneyFixtures(page: Page) {
  for (const table of [
    "project_financials",
    "job_costs",
    "change_orders",
    "time_shifts",
    "pay_rates",
    "bank_transactions",
    "bank_imports",
    "receipts",
    "capability_badges",
    "saved_crews",
  ]) {
    await page.route(`**/rest/v1/${table}**`, (r) => json(r, [], 0));
  }
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

// ---------------------------------------------------------------- Z1: grants

test("a foreman with no grant is still kept out of the Cost screen", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useMoneyFixtures(page);

  await page.goto("/costing");
  await expect(page.getByText("Not available for your role")).toBeVisible();
});

test('the same foreman walks in once the owner has ticked "Sees costs"', async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman", canSeeCosts: true });
  await useMoneyFixtures(page);

  await page.goto("/costing");
  await expect(page.getByRole("heading", { name: "Job costing" })).toBeVisible();
  await expect(page.getByText("Not available for your role")).toHaveCount(0);
  // The rank floor is untouched — the grant opened this door and no other.
  await page.goto("/account/builders");
  await expect(page.getByText("Not available for your role")).toBeVisible();
});

test("only an owner is offered the two grant checkboxes, and ticking one sends set_profile_grants", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "owner" });
  await useMoneyFixtures(page);

  const granted: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/set_profile_grants", async (route) => {
    granted.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/crew");
  const costs = page.getByRole("checkbox", { name: "Sees costs" }).first();
  await expect(costs).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Sees pay rates" }).first()).toBeVisible();

  // click(), not check(): the box is controlled by the profiles query, so it
  // only moves once the server has actually said yes — which is the honest
  // behaviour for a permission, and means check()'s "did the state change"
  // assertion is measuring the mocked route rather than the app.
  await costs.click();
  await expect.poll(() => granted.length).toBe(1);
  // Only the box that was ticked moves: null leaves the other grant alone, so
  // the two checkboxes flip independently.
  expect(granted[0]).toMatchObject({ p_costs: true, p_pay: null });
});

// The nav and the page have to agree about who may walk in. canAccess() opens
// /ai-spend for a cost-grant holder and menuForRole() draws the row, so a page
// that still gated on isOwner() drew a link onto a wall — a granted person
// tapped "AI spend" in the drawer and landed on "ask an owner". That is exactly
// the failure a unit test on nav.ts cannot see, because both halves pass on
// their own.
test("a granted foreman who taps AI spend lands on the screen, not a refusal", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman", canSeeCosts: true });
  await useMoneyFixtures(page);
  await page.route("**/rest/v1/rpc/ai_spend_overview", (r) =>
    json(r, {
      // can_edit false: the grant opens the WINDOW onto the meter. Moving the
      // limits is still the owner's, decided by the RPC and not by this screen.
      can_edit: false,
      limits: {
        per_user_daily_calls: 40,
        monthly_cap_cents: 5000,
        content_multiplier: 1,
        min_role: "installer",
        alert_at_pct: 80,
        enforced: true,
        timezone: "America/Denver",
        updated_at: "2026-09-01T00:00:00Z",
      },
      month: {
        usage_month: "2026-09-01",
        calls: 12,
        spent_micros: 1_200_000,
        reserved_micros: 0,
        cap_micros: 50_000_000,
      },
      people: [],
      functions: [],
      alerts: [],
    }),
  );

  await page.goto("/ai-spend");
  await expect(page.getByRole("heading", { name: "AI spend" })).toBeVisible();
  await expect(page.getByText("Not available for your role")).toHaveCount(0);
  await expect(page.getByText("Ask an owner to turn on", { exact: false })).toHaveCount(0);
});

test("a foreman with no grant is told how to get in, and told nothing else", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  await useMoneyFixtures(page);

  await page.goto("/ai-spend");
  await expect(page.getByText("Not available for your role")).toBeVisible();
});

test("a supervisor sees no grant checkboxes at all — money is an owner's to hand out", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useMoneyFixtures(page);

  await page.goto("/crew");
  await expect(page.getByRole("heading", { name: "Roster" }).first()).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Sees costs" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Sees pay rates" })).toHaveCount(0);
});

// ------------------------------------------------- Z4: the cost-code picker

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("the receipt sheet's cost-code picker sends the code through its own RPC", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });

  await page.route("**/storage/v1/object/**", (route) => {
    const url = route.request().url();
    if (url.includes("/object/sign/")) return json(route, { signedURL: "/x.jpg" });
    return json(route, { Key: "install-media/receipts/x.jpg" });
  });
  await page.route("**/rest/v1/cost_codes**", (r) =>
    json(
      r,
      [
        {
          id: "cc-100",
          code: "100",
          label: "Install — windows",
          description: null,
          active: true,
          sort_order: 10,
          is_general: false,
        },
      ],
      1,
    ),
  );
  await page.route("**/rest/v1/receipts**", (r) =>
    json(r, { amount_cents: null, vendor: null, purchased_on: null, category: null, note: null }),
  );
  await page.route("**/rest/v1/rpc/file_receipt", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: body.p_id, ...body }),
    });
  });
  await page.route("**/rest/v1/rpc/update_receipt", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "null" }),
  );
  const coded: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/set_receipt_cost_code", async (route) => {
    coded.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
  });

  await page.goto("/photos?kind=receipt&capture=1");
  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    });

  await expect(page.getByText("Bill this to the customer?")).toBeVisible();
  await page.getByRole("button", { name: /100 — Install/ }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect.poll(() => coded.length).toBe(1);
  expect(coded[0]).toMatchObject({ p_cost_code_id: "cc-100" });
});

// --------------------------------------------- Z5: the header-mapping step

const STATEMENT = [
  '"Posted Date","Card Holder","Description","Amount","Reference"',
  '"08/25/2026","Maria G","HOME DEPOT #4512 OREM UT","$147.13","TX-9001"',
  '"08/28/2026","Sam T","LUNCH MEETING","not a number","TX-9004"',
].join("\n");

test("a dropped-in statement is mapped by a human before a single row is imported", async ({
  page,
}) => {
  // Cost-seeing supervisor: the bookkeeper this section is built for.
  await useSupabaseFixtures(page, { role: "supervisor", canSeeCosts: true });
  await useMoneyFixtures(page);

  const imported: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/import_bank_transactions", async (route) => {
    imported.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "batch-1",
        filename: "statement-2026-08.csv",
        imported_at: new Date().toISOString(),
        row_count: 1,
        undone_at: null,
      }),
    });
  });

  await page.goto("/receipts");
  await expect(page.getByRole("heading", { name: "Company card" })).toBeVisible();

  await page
    .locator('input[type="file"][aria-label="Bank statement file"]')
    .setInputFiles({
      name: "statement-2026-08.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(STATEMENT, "utf8"),
    });

  // The confirmation step, with the app's guess already filled in — a guess is
  // an opening offer here, never a conclusion.
  await expect(page.getByRole("heading", { name: "Which column is which?" })).toBeVisible();
  await expect(page.getByLabel("Date")).toHaveValue("Posted Date");
  await expect(page.getByLabel("Amount")).toHaveValue("Amount");
  await expect(page.getByLabel("Cardholder")).toHaveValue("Card Holder");
  // The row whose amount reads as nothing is called out BEFORE the import, so a
  // wrong Amount column is caught by a person rather than by silence.
  await expect(page.getByText(/1 row\(s\) have no amount/)).toBeVisible();

  await page.getByRole("button", { name: "Import", exact: true }).click();

  await expect.poll(() => imported.length).toBe(1);
  const rows = imported[0].p_rows as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    posted_on: "2026-08-25",
    amount_cents: 14713,
    cardholder: "Maria G",
    external_id: "TX-9001",
  });
  expect(imported[0].p_filename).toBe("statement-2026-08.csv");
});

// Chase, Amex and most card exports write a PURCHASE as a negative number,
// because they are describing the balance. Read that way round every charge
// imports negative, no receipt can ever equal one, and the auto-match proposes
// nothing at all — forever, with nothing on screen to say why. So the mapping
// step asks the sign question too, opens with the answer read off the file, and
// shows what the first charge would import as.
const NEGATIVE_STATEMENT = [
  '"Posted Date","Card Holder","Description","Amount","Reference"',
  '"08/25/2026","Maria G","HOME DEPOT #4512 OREM UT","-147.13","TX-9001"',
  '"08/26/2026","Sam T","SHELL OIL 574123 LEHI","-62.40","TX-9002"',
].join("\n");

test("a statement that writes purchases as negatives is spotted and imported as money out", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor", canSeeCosts: true });
  await useMoneyFixtures(page);

  const imported: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/rpc/import_bank_transactions", async (route) => {
    imported.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "batch-2",
        filename: "chase-2026-08.csv",
        imported_at: new Date().toISOString(),
        row_count: 2,
        undone_at: null,
      }),
    });
  });

  await page.goto("/receipts");
  await page
    .locator('input[type="file"][aria-label="Bank statement file"]')
    .setInputFiles({
      name: "chase-2026-08.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(NEGATIVE_STATEMENT, "utf8"),
    });

  await expect(page.getByRole("heading", { name: "Which column is which?" })).toBeVisible();
  // Read off the file, not off the header names — no header says which way
  // round a statement is written.
  const sign = page.getByRole("checkbox", {
    name: "Purchases are negative numbers in this file",
  });
  await expect(sign).toBeChecked();
  // And shown, because this is a question a person can only answer by seeing
  // the answer: a purchase should read positive.
  await expect(page.getByText("First charge reads as")).toContainText("$147.13");

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect.poll(() => imported.length).toBe(1);
  const rows = imported[0].p_rows as Record<string, unknown>[];
  expect(rows.map((r) => r.amount_cents)).toEqual([14713, 6240]);
});

test("a supervisor with no cost grant never sees the company card section", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useMoneyFixtures(page);

  await page.goto("/receipts");
  // The office table itself is supervisor+, unchanged.
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
  // The card statement is money, so it answers to the grant, not the rank.
  await expect(page.getByRole("heading", { name: "Company card" })).toHaveCount(0);
});

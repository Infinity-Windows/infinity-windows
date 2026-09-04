// Remove a login and start fresh, plus the access-request queue's hygiene.
//
// FOUR THINGS A UNIT TEST CANNOT SHOW, which is why they are here:
//
//   1. The confirm sheet SAYS WHICH OF TWO THINGS will happen, in this
//      person's own name, before anything is pressed. That is the whole safety
//      of a destructive button, and it depends on the screen asking the server
//      first and rendering the answer — not on a pure function returning a
//      string.
//   2. Confirming sends `purge_login` for that exact user id. The preview and
//      the purge are two different actions on one endpoint; sending the wrong
//      one is a bug no type checks.
//   3. A supervisor is never offered it. Every rule is re-checked server-side,
//      but a supervisor who can SEE the button will press it and be refused,
//      which is a worse screen than one that never offered.
//   4. Admin's queue: a denial carries the reason that was typed, Re-open puts
//      it back as pending, and "they already have a login" — the commonest
//      thing that goes wrong in this queue — has a one-tap outcome instead of
//      a row stuck in Pending forever.
//
// Every count is mocked, because the counts ARE the branch: a real database
// would have whatever it has, and this has to prove both shapes.

import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";

const ENRIQUE = "11111111-1111-4111-8111-111111111111";
const EDUARDO = "22222222-2222-4222-8222-222222222222";

/** The Crew access screen reads this view, not `profiles`. */
const DIRECTORY = [
  {
    id: TEST_USER.id,
    display_name: "E2E Fixture",
    role: "owner",
    skill_level: 3,
    active: true,
    access_revoked_at: null,
    retired_at: null,
    retired_by: null,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: ENRIQUE,
    display_name: "Enrique Salas",
    role: "installer",
    skill_level: 3,
    active: true,
    access_revoked_at: null,
    retired_at: null,
    retired_by: null,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: EDUARDO,
    display_name: "Eduardo Reyes",
    role: "installer",
    skill_level: 2,
    active: true,
    access_revoked_at: null,
    retired_at: null,
    retired_by: null,
    created_at: "2026-01-01T00:00:00Z",
  },
];

/** Fourteen punches and three receipts — the "keep everything" branch. */
const ENRIQUE_COUNTS = {
  "time_shifts.profile_id": 14,
  "receipts.uploaded_by": 3,
};
/** Nothing anywhere — the "delete it outright" branch. */
const NOTHING = {};

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/**
 * Answer manage-crew-access from fixtures and remember every call.
 *
 * Registered AFTER useSupabaseFixtures so it wins — Playwright favours the most
 * recently added route, and the fixture router answers every edge function with
 * a 501.
 */
async function routeCrewAccess(
  page: Page,
  countsByUser: Record<string, Record<string, number>>,
  /** A refusal the preview answers with, the way the real endpoint does. */
  refusal?: { user_id: string; error: string },
): Promise<{ calls: Record<string, unknown>[] }> {
  const calls: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/crew_access_directory**", (r) =>
    json(r, DIRECTORY, DIRECTORY.length),
  );
  await page.route("**/rest/v1/crew_invites**", (r) => json(r, [], 0));
  await page.route("**/functions/v1/manage-crew-access", (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);
    const userId = String(body.user_id ?? "");
    const person = DIRECTORY.find((p) => p.id === userId);
    const counts = countsByUser[userId] ?? {};
    if (body.action === "purge_login_preview") {
      if (refusal && userId === refusal.user_id) {
        return r.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: refusal.error }),
        });
      }
      return json(r, {
        ok: true,
        user_id: userId,
        display_name: person?.display_name ?? null,
        counts,
        shape: Object.values(counts).some((n) => n > 0) ? "retired" : "deleted",
      });
    }
    if (body.action === "purge_login") {
      return json(r, {
        ok: true,
        shape: Object.values(counts).some((n) => n > 0) ? "retired" : "deleted",
        email_released: true,
        display_name: person?.display_name ?? null,
      });
    }
    return json(r, { ok: true });
  });
  return { calls };
}

function memberRow(page: Page, name: string) {
  return page.locator("li.find-row").filter({ hasText: name });
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("the sheet says the record is kept, and confirming sends purge_login", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "owner" });
  const { calls } = await routeCrewAccess(page, {
    [ENRIQUE]: ENRIQUE_COUNTS,
    [EDUARDO]: NOTHING,
  });

  await page.goto("/access");
  const row = memberRow(page, "Enrique Salas");
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Remove this login…" }).click();

  // The sentence is the safety. It names the person, the numbers, and the
  // promise — "every record kept under their name".
  const sentence = row.getByTestId("purge-shape-sentence");
  await expect(sentence).toHaveText(
    "Enrique Salas has 14 punches and 3 receipts on file — the login will be " +
      "closed, the email freed, and every record kept under their name.",
  );
  // And the button names what it will do, not "OK".
  await expect(row.getByTestId("purge-confirm")).toHaveText("Yes, close the login");

  // Asking must not have changed anything.
  expect(calls.map((c) => c.action)).toEqual(["purge_login_preview"]);

  await row.getByTestId("purge-confirm").click();
  await expect(page.getByText(/every record is still filed under their name/)).toBeVisible();

  expect(calls).toEqual([
    { action: "purge_login_preview", user_id: ENRIQUE },
    { action: "purge_login", user_id: ENRIQUE },
  ]);
});

test("a login with nothing behind it says it will be deleted", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "owner" });
  const { calls } = await routeCrewAccess(page, {
    [ENRIQUE]: ENRIQUE_COUNTS,
    [EDUARDO]: NOTHING,
  });

  await page.goto("/access");
  const row = memberRow(page, "Eduardo Reyes");
  await row.getByRole("button", { name: "Remove this login…" }).click();

  await expect(row.getByTestId("purge-shape-sentence")).toHaveText(
    "Nothing on file for Eduardo Reyes — the account will be deleted and the email freed.",
  );
  await expect(row.getByTestId("purge-confirm")).toHaveText(
    "Yes, delete the account",
  );

  await row.getByTestId("purge-confirm").click();
  await expect(
    page.getByText("Eduardo Reyes's account is gone and the email is free to use again."),
  ).toBeVisible();
  expect(calls.at(-1)).toEqual({ action: "purge_login", user_id: EDUARDO });
});

/**
 * The refusals reach the owner BEFORE he commits to anything.
 *
 * Removing a login cannot be undone, so every refusal is checked by the preview
 * as well as by the removal itself — a sheet that promised "the email will be
 * freed" and then refused would be the worst of both. The one mocked here is
 * the automation login the end-to-end checks sign in with, but the shape is the
 * same for a builder's login and for a database that is running behind the app
 * and could not write the removal down.
 */
test("a refusal is shown instead of a promise, and there is nothing to press", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "owner" });
  const refused =
    "That's the automation login the tests sign in with, not a person's login. " +
    "Removing it would break the checks that run before every deploy.";
  const { calls } = await routeCrewAccess(
    page,
    { [ENRIQUE]: ENRIQUE_COUNTS },
    { user_id: ENRIQUE, error: refused },
  );

  await page.goto("/access");
  const row = memberRow(page, "Enrique Salas");
  await row.getByRole("button", { name: "Remove this login…" }).click();

  await expect(row.getByTestId("purge-sheet")).toContainText(refused);
  // No sentence promising anything, and no button to confirm it with.
  await expect(row.getByTestId("purge-shape-sentence")).toHaveCount(0);
  await expect(row.getByTestId("purge-confirm")).toHaveCount(0);

  // And asking must not have removed anything.
  expect(calls.map((c) => c.action)).toEqual(["purge_login_preview"]);
});

test("a supervisor is never offered the third door", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await routeCrewAccess(page, { [ENRIQUE]: ENRIQUE_COUNTS });

  await page.goto("/access");
  const row = memberRow(page, "Enrique Salas");
  await expect(row).toBeVisible();
  // They still get the reversible door — that is the point of two doors.
  await expect(row.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Remove this login…" }),
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// The access-request queue
// ---------------------------------------------------------------------------

const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

function pendingRequest(over: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    name: "Marisol Vega",
    email: "marisol@example.com",
    phone: null,
    requested_role: "installer",
    note: null,
    status: "pending",
    decided_by: null,
    decided_at: null,
    decision_note: null,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

/**
 * An access_requests router that remembers what the RPC did to it, the way the
 * real database would — so the decided list reads back the change rather than
 * believing the page's own optimistic state.
 */
function routeAccessRequests(page: Page, approveBody: unknown, approveStatus = 200) {
  const state = { rows: [pendingRequest()] as Record<string, unknown>[] };
  const calls: { fn: string; body: Record<string, unknown> }[] = [];

  void page.route("**/rest/v1/access_requests**", (r) =>
    json(r, state.rows, state.rows.length),
  );
  void page.route("**/rest/v1/rpc/decide_access_request", (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    calls.push({ fn: "decide_access_request", body });
    state.rows = state.rows.map((row) =>
      row.id === body.p_id
        ? {
            ...row,
            status: body.p_status,
            decided_by: body.p_status === "pending" ? null : TEST_USER.id,
            decided_at: body.p_status === "pending" ? null : "2026-09-04T12:00:00Z",
            decision_note: body.p_status === "pending" ? null : body.p_note,
          }
        : row,
    );
    return json(r, null, 0);
  });
  void page.route("**/functions/v1/approve-access-request", (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    calls.push({ fn: "approve-access-request", body });
    if (body.action === "mark_already_linked") {
      state.rows = state.rows.map((row) =>
        row.id === body.request_id
          ? {
              ...row,
              status: "approved",
              decided_by: TEST_USER.id,
              decided_at: "2026-09-04T12:00:00Z",
              decision_note: "Already had a login",
            }
          : row,
      );
      return json(r, { ok: true, marked: "already_has_login" });
    }
    return r.fulfill({
      status: approveStatus,
      contentType: "application/json",
      body: JSON.stringify(approveBody),
    });
  });

  return { calls, rows: () => state.rows };
}

test("denying asks why, and the decided list says who, when and why", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const { calls } = routeAccessRequests(page, { ok: true });

  await page.goto("/admin");
  const row = page.locator("li.find-row").filter({ hasText: "Marisol Vega" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Deny" }).click();
  await row.getByTestId("deny-reason").fill("not hiring right now");
  await row.getByTestId("deny-confirm").click();

  // The reason went over on the RPC — not a PATCH, which is the whole point:
  // only supervisor+ may write a decision now, and only the server may say
  // 'approved'.
  expect(calls).toEqual([
    {
      fn: "decide_access_request",
      body: {
        p_id: REQUEST_ID,
        p_status: "denied",
        p_note: "not hiring right now",
      },
    },
  ]);

  await expect(page.getByText("Recent decisions")).toBeVisible();
  const decided = page.locator("li.find-row").filter({ hasText: "Marisol Vega" });
  await expect(decided.getByTestId("decision-note")).toHaveText(
    "“not hiring right now”",
  );
  await expect(decided).toContainText("Denied by");
});

test("Re-open puts a denial back in the queue", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const { calls } = routeAccessRequests(page, { ok: true });

  await page.goto("/admin");
  const row = page.locator("li.find-row").filter({ hasText: "Marisol Vega" });
  await row.getByRole("button", { name: "Deny" }).click();
  await row.getByTestId("deny-confirm").click();
  await expect(page.getByTestId("reopen-request")).toBeVisible();

  await page.getByTestId("reopen-request").click();

  // Back in Pending, with the old reason cleared — a note saying why it was
  // denied would read as this decision rather than the one that was undone.
  await expect(page.getByRole("heading", { name: "Access requests (1)" })).toBeVisible();
  await expect(page.getByTestId("decision-note")).toHaveCount(0);
  expect(calls.at(-1)).toEqual({
    fn: "decide_access_request",
    body: { p_id: REQUEST_ID, p_status: "pending", p_note: null },
  });
});

test("a request from somebody who already has a login is cleared in one tap", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const { calls } = routeAccessRequests(
    page,
    {
      code: "already_has_login",
      email: "marisol@example.com",
      error:
        'marisol@example.com already has an account. They should sign in, or use "Reset password" on the sign-in screen.',
    },
    409,
  );

  await page.goto("/admin");
  const row = page.locator("li.find-row").filter({ hasText: "Marisol Vega" });
  await row.getByRole("button", { name: /Approve/ }).click();

  // The sentence is shown, AND the row offers the way out — which is the part
  // that did not exist before: this request used to sit in Pending forever.
  await expect(page.getByText(/already has an account/)).toBeVisible();
  await expect(row.getByTestId("already-has-login")).toBeVisible();

  await row.getByTestId("mark-already-has-login").click();

  await expect(page.getByText("Recent decisions")).toBeVisible();
  const decided = page.locator("li.find-row").filter({ hasText: "Marisol Vega" });
  await expect(decided.getByTestId("decision-note")).toHaveText(
    "“Already had a login”",
  );
  // Filed by the edge function on the service role — the client never writes
  // 'approved' itself.
  expect(calls.at(-1)).toEqual({
    fn: "approve-access-request",
    body: { request_id: REQUEST_ID, action: "mark_already_linked" },
  });
});

// Wave O — credentials, on the real Roster and the real My Work.
//
// Six things this proves that a unit test cannot:
//   O2  a card's chip carries its own sentence as well as its colour — green,
//       amber, red and grey, on four cards whose dates are built to sit exactly
//       on the boundaries the rule cares about.
//   O1  marking a card checked sends ONE thing. Verifying is an RPC that takes
//       every column, and a caller that filled in the ones the button never
//       asked about would wipe the expiry date on the way past — which is
//       exactly the bug wave J's Pipeline card shipped and had to fix.
//   O3  the skill tree really does put badges, cleared window types and cards
//       in one place on one row.
//   O5  the summary line counts only checked, unexpired cards, and the text it
//       copies carries no names.
//   O1  a foreman reads everything and is offered no supervisor tap.
//   O1  somebody adds their OWN card from My Work, it goes over with no verify
//       flag, and the camera is offered on their own card and on nobody else's.
//
// The cards are hand-built rather than captured, because the dates ARE the test.

import { expect, test, type Page, type Route } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";

const MARIA = "69a880bc-8489-48d5-8673-28dcfd5b0210";
const DAVE = "0830d61d-3ed5-4a03-9efc-846dbfc3dce9";
const CHRIS = "88e9158c-c299-4abf-86e2-4d6c1134d0be";

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function cert(over: Record<string, unknown>) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    profile_id: MARIA,
    kind: "osha30",
    other_label: null,
    issued_on: day(-400),
    expires_on: day(400),
    document_path: null,
    verified_by: "sup",
    verified_at: "2026-01-01T00:00:00Z",
    created_by: MARIA,
    created_at: "2026-01-01T00:00:00Z",
    voided_at: null,
    ...over,
  };
}

// Green: comfortably more than thirty days left.
const GOOD = cert({ id: "00000000-0000-4000-8000-00000000000a" });
// Amber: exactly on the thirty-day boundary, which is the day the chip is
// meant to turn — one day either side of this is the assertion worth having.
const SOON = cert({
  id: "00000000-0000-4000-8000-00000000000b",
  kind: "aerial_lift",
  expires_on: day(30),
});
// Red: gone yesterday.
const EXPIRED = cert({
  id: "00000000-0000-4000-8000-00000000000c",
  kind: "forklift",
  profile_id: DAVE,
  expires_on: day(-1),
});
// Grey: a card with no expiry printed on it. Verified, so it still counts on a
// bid — which is what a card with no expiry means.
const NO_EXPIRY = cert({
  id: "00000000-0000-4000-8000-00000000000d",
  kind: "osha10",
  profile_id: DAVE,
  expires_on: null,
});
// Unverified: on file, on screen, and counted nowhere.
const UNCHECKED = cert({
  id: "00000000-0000-4000-8000-00000000000e",
  kind: "osha10",
  profile_id: CHRIS,
  expires_on: day(200),
  verified_at: null,
  verified_by: null,
});

const ALL_CERTS = [GOOD, SOON, EXPIRED, NO_EXPIRY, UNCHECKED];

const BADGES = [
  { installer_id: MARIA, capability: "doors", granted_at: "2026-02-01T00:00:00Z" },
  { installer_id: MARIA, capability: "retrofit", granted_at: "2026-02-01T00:00:00Z" },
];

const CLEARANCES = [
  { installer_id: MARIA, window_type_id: "t1", cleared_at: "2026-02-01T00:00:00Z" },
  { installer_id: MARIA, window_type_id: "t2", cleared_at: "2026-02-01T00:00:00Z" },
  { installer_id: MARIA, window_type_id: "t3", cleared_at: "2026-02-01T00:00:00Z" },
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/**
 * A credentials router that remembers what the RPC did to it, the way the real
 * database would — so a page that refetches after a write reads the change back
 * rather than believing its own optimistic state.
 *
 * Registered AFTER useSupabaseFixtures so it wins (Playwright favours the most
 * recently added route).
 */
function useCredentialFixtures(page: Page, certs = ALL_CERTS) {
  const state = { rows: certs.map((c) => ({ ...c })) as Record<string, unknown>[] };
  const calls: { fn: string; body: Record<string, unknown> }[] = [];

  void page.route("**/rest/v1/rpc/set_certification", async (r) => {
    const body = r.request().postDataJSON() as Record<string, unknown>;
    calls.push({ fn: "set_certification", body });
    if (body.p_id) {
      state.rows = state.rows.map((row) =>
        row.id === body.p_id
          ? {
              ...row,
              verified_at:
                body.p_verified === true
                  ? new Date().toISOString()
                  : body.p_verified === false
                    ? null
                    : row.verified_at,
              voided_at: body.p_voided === true ? new Date().toISOString() : row.voided_at,
            }
          : row,
      );
    } else {
      state.rows = [
        ...state.rows,
        {
          ...cert({}),
          id: `new-${state.rows.length}`,
          profile_id: body.p_profile_id ?? TEST_USER.id,
          kind: body.p_kind,
          other_label: body.p_other_label ?? null,
          issued_on: body.p_issued_on ?? null,
          expires_on: body.p_expires_on ?? null,
          // Whatever the call asked for, a self-added card lands unchecked —
          // the server's rule, mirrored here so the page reads back the truth.
          verified_at: null,
          verified_by: null,
        },
      ];
    }
    return json(r, null, 0);
  });

  void page.route("**/rest/v1/certifications**", (r) => {
    const url = new URL(r.request().url());
    const raw = url.searchParams.get("profile_id");
    const only = raw?.startsWith("eq.") ? raw.slice(3) : null;
    const rows = state.rows.filter(
      (row) => row.voided_at == null && (!only || row.profile_id === only),
    );
    return json(r, rows, rows.length);
  });

  void page.route("**/rest/v1/capability_badges**", (r) => json(r, BADGES, BADGES.length));
  void page.route("**/rest/v1/installer_clearance**", (r) =>
    json(r, CLEARANCES, CLEARANCES.length),
  );

  return { calls, rows: () => state.rows };
}

/**
 * The Roster row for one person.
 *
 * By the name INPUT, not by text: the roster renders each name as an editable
 * <input defaultValue={…}>, and an input's value is not text content, so a
 * hasText filter matches nothing at all.
 */
function row(page: Page, name: string) {
  return page
    .locator("li.crew-row")
    .filter({ has: page.locator(`input.crew-name[value="${name}"]`) });
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("a card's chip says what it means, not only what colour it is", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  useCredentialFixtures(page);
  await page.goto("/crew");

  const maria = row(page, "Maria");
  await expect(maria).toBeVisible();
  // Green, and the sentence carries the date so somebody who cannot tell the
  // red from the amber still reads the fact.
  await expect(maria.locator(".cred-chip.ok")).toHaveText(/Good until/i);
  // Amber lands ON the thirtieth day, not the day after.
  await expect(maria.locator(".cred-chip.soon")).toHaveText(/Runs out/i);

  const dave = row(page, "Dave");
  await expect(dave.locator(".cred-chip.expired")).toHaveText(/Expired/i);
  // Grey: a card with no expiry printed on it. Not a warning, not a green
  // light — nobody said when it runs out.
  await expect(dave.locator(".cred-chip.none")).toHaveText(/No expiry/i);

  // An unchecked card says so beside its chip.
  await expect(row(page, "Chris").locator(".cred-unchecked")).toHaveText(/Not checked yet/i);
});

test("marking a card checked sends the verify and nothing else", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const fixtures = useCredentialFixtures(page);
  await page.goto("/crew");

  const chris = row(page, "Chris");
  await expect(chris.getByRole("button", { name: /^Mark checked$/ })).toBeVisible();
  await chris.getByRole("button", { name: /^Mark checked$/ }).click();

  await expect
    .poll(() => fixtures.calls.filter((c) => c.fn === "set_certification").length)
    .toBeGreaterThan(0);
  const body = fixtures.calls[fixtures.calls.length - 1].body;
  expect(body.p_id).toBe(UNCHECKED.id);
  expect(body.p_verified).toBe(true);
  // THE POINT: the button never asked about a date, so the call carries none —
  // and the clear flags stay false, or one tap on "Mark checked" would blank
  // the expiry this whole wave exists to watch.
  expect(body.p_expires_on).toBeNull();
  expect(body.p_issued_on).toBeNull();
  expect(body.p_clear_expires).toBe(false);
  expect(body.p_clear_issued).toBe(false);

  // And the page reads the change back from the server, not from its own hope.
  await expect(chris.locator(".cred-checked")).toHaveText(/Checked/i);
});

test("the skill tree puts badges, cleared types and cards in one place", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  useCredentialFixtures(page);
  await page.goto("/crew");

  const tree = row(page, "Maria").locator(".skill-tree");
  await expect(tree).toBeVisible();
  await expect(tree).toContainText(/Badges/i);
  await expect(tree).toContainText(/3 types cleared/i);
  await expect(tree).toContainText("OSHA 30");
  await expect(tree).toContainText(/Aerial lift/i);

  // Somebody with nothing on file is not pretended to have something.
  await expect(row(page, "Sam").locator(".cred-section")).toContainText(
    /No cards on file yet/i,
  );
});

test("the credential summary counts checked, unexpired cards and copies no names", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  useCredentialFixtures(page);
  // A clipboard stub rather than a browser permission: what matters is the
  // exact text handed over, and the real clipboard is not readable in every
  // browser this suite runs in.
  await page.addInitScript(() => {
    const w = window as unknown as { __copied?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          w.__copied = text;
          return Promise.resolve();
        },
      },
    });
  });
  await page.goto("/crew");

  const summary = page.locator(".cred-summary");
  await expect(summary).toBeVisible();
  // GOOD (OSHA 30), SOON (aerial lift) and NO_EXPIRY (OSHA 10) count. The
  // expired forklift and the unchecked OSHA 10 do not.
  await expect(summary.locator(".cred-summary-line")).toHaveText(
    "1 OSHA 30 · 1 OSHA 10 · 1 Aerial lift",
  );

  await summary.getByRole("button", { name: /Copy as text/i }).click();
  const copied = await page.evaluate(
    () => (window as unknown as { __copied?: string }).__copied ?? "",
  );
  expect(copied).toBe("1 OSHA 30 · 1 OSHA 10 · 1 Aerial lift");
  // THE POINT: this line gets pasted into somebody else's document.
  expect(copied).not.toMatch(/maria|dave|chris|sam/i);
});

test("a foreman reads every card and is offered no supervisor tap", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "foreman" });
  useCredentialFixtures(page);
  await page.goto("/crew");

  // Knowing half the crew cannot go up in a lift is exactly what a foreman
  // needs, so the cards are not hidden — only the buttons are.
  await expect(row(page, "Maria").locator(".cred-chip.ok")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Mark checked$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Void$/ })).toHaveCount(0);
  // The summary is a number about the company, and it is written to be copied
  // out of the app, so it stays supervisor+.
  await expect(page.locator(".cred-summary")).toHaveCount(0);
  // A foreman may still add their own card — that write needs no rank.
  await expect(page.getByRole("button", { name: /Add my card/i })).toHaveCount(1);
});

test("somebody adds their own card from My Work and it goes over unchecked", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const fixtures = useCredentialFixtures(page, []);
  await page.goto("/my-work");

  const tree = page.locator(".skill-tree");
  await expect(tree).toBeVisible();
  // Nobody checks their own card, whatever the screen offered.
  await expect(tree.getByRole("button", { name: /^Mark checked$/ })).toHaveCount(0);

  await tree.getByRole("button", { name: /Add my card/i }).click();
  await page.getByRole("button", { name: /^OSHA 30$/ }).click();
  await page.getByLabel(/^Runs out$/).fill(day(90));
  // The camera is offered, and it says out loud that this shot carries no
  // stamp — a card is a piece of paper, not proof of where somebody stood.
  await expect(page.getByText(/No stamp on this one/i)).toBeVisible();
  await page.getByRole("button", { name: /^Save card$/ }).click();

  await expect
    .poll(() => fixtures.calls.filter((c) => c.fn === "set_certification").length)
    .toBeGreaterThan(0);
  const body = fixtures.calls[fixtures.calls.length - 1].body;
  expect(body.p_id).toBeNull();
  expect(body.p_profile_id).toBe(TEST_USER.id);
  expect(body.p_kind).toBe("osha30");
  expect(body.p_expires_on).toBe(day(90));
  // THE POINT: the app never asks for a card of its own to be trusted.
  expect(body.p_verified).toBeNull();

  // And it comes back reading "Not checked yet", from the server.
  await expect(page.locator(".cred-unchecked")).toHaveText(/Not checked yet/i);
});

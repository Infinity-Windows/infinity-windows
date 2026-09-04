// Wave H (H2) — the page a general contractor opens from a text message.
//
// Deliberately WITHOUT useSupabaseFixtures, because the thing being proved is
// that this page needs no session at all. There is no signed-in user seeded
// here, no profile, no PIN: a builder taps a link and reads the six questions.
// If this page ever starts waiting on getSession() it will hang in this spec
// exactly the way it would hang on his phone.
//
// Four things:
//   - a live token renders the job, the brand the office chose, and the six
//     questions, with no login and no session anywhere.
//   - answering sends ONE call to the gc-link function with all six, and the
//     page says thank you.
//   - a half-filled answer never leaves the phone, and names the empty box.
//   - an expired or revoked token shows the one plain sentence and nothing
//     else — no form, no thread, no job name.

import { expect, test, type Page, type Route } from "@playwright/test";

/** 43 characters of base64url, the shape create_gc_link mints. */
const TOKEN = "Zm9yZ2Utd2luZG93cy1nYy1saW5rLXRva2VuLTMyYnl0ZXM";

interface FnCall {
  action: string;
  body: Record<string, unknown>;
}

function useGcLinkFunction(
  page: Page,
  answer: (body: Record<string, unknown>) => { status: number; json: unknown },
) {
  const calls: FnCall[] = [];

  // No session, so the auth endpoints are answered as "nobody" rather than
  // being left to hit a host that does not resolve.
  void page.route("**/auth/v1/**", (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  // Nothing on this page reads a table. Anything that did would show up here
  // as a call that should not exist.
  void page.route("**/rest/v1/**", (r: Route) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );

  void page.route("**/functions/v1/gc-link", async (r: Route) => {
    const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ action: String(body.action ?? "open"), body });
    const out = answer(body);
    return r.fulfill({
      status: out.status,
      contentType: "application/json",
      body: JSON.stringify(out.json),
    });
  });

  return { calls };
}

const LIVE = {
  job: "Sand Hollow",
  brand: "stg",
  answers: null,
  thread: [] as unknown[],
};

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("a GC opens the link and reads the six questions, with no login at all", async ({ page }) => {
  useGcLinkFunction(page, () => ({ status: 200, json: LIVE }));
  await page.goto(`/gc/${TOKEN}`);

  // The job, and the brand the office chose for it (Q20).
  await expect(page.getByRole("heading", { name: "Sand Hollow" })).toBeVisible();
  await expect(page.getByText("STG Windows & Doors")).toBeVisible();

  // All six, on one screen.
  await expect(page.getByLabel("When do you expect the house to be finished?")).toBeVisible();
  await expect(page.getByLabel("When does the roof go on?")).toBeVisible();
  await expect(page.getByText("Has the framing been checked?")).toBeVisible();
  await expect(page.getByText("Do you want the windows inset or outset?")).toBeVisible();
  await expect(page.getByLabel("What is going on the outside?")).toBeVisible();
  await expect(page.getByLabel("What is going on the inside?")).toBeVisible();

  // And nothing of ours. The builder must never learn from this page that we
  // are behind — which is what H0 moved readiness off `projects` to guarantee.
  await expect(page.getByText(/Not ready/i)).toHaveCount(0);
  await expect(page.getByText(/Sign in/i)).toHaveCount(0);
});

test("the GC answers and all six go over in one call", async ({ page }) => {
  const fixtures = useGcLinkFunction(page, (body) =>
    body.action === "answer" ? { status: 200, json: { ok: true } } : { status: 200, json: LIVE },
  );
  await page.goto(`/gc/${TOKEN}`);

  await page.getByLabel("When do you expect the house to be finished?").fill("2026-11-20");
  await page.getByLabel("When does the roof go on?").fill("2026-09-30");
  await page.getByRole("button", { name: /^Yes$/ }).click();
  await page.getByRole("button", { name: /^Outset$/ }).click();
  await page.getByLabel("What is going on the outside?").fill("Stucco");
  await page.getByLabel("What is going on the inside?").fill("Drywall");
  await page.getByLabel("Your name").fill("Dave");
  await page.getByRole("button", { name: /Send these to the crew/i }).click();

  await expect.poll(() => fixtures.calls.filter((c) => c.action === "answer").length).toBe(1);
  const sent = fixtures.calls.find((c) => c.action === "answer")!.body;
  expect(sent.token).toBe(TOKEN);
  expect(sent.expectedEndDate).toBe("2026-11-20");
  expect(sent.roofOnDate).toBe("2026-09-30");
  expect(sent.framingChecked).toBe(true);
  expect(sent.setPreference).toBe("outset");
  expect(sent.exteriorMaterial).toBe("Stucco");
  expect(sent.interiorMaterial).toBe("Drywall");
  expect(sent.contactName).toBe("Dave");

  await expect(page.getByText(/Thank you — the crew has it/i)).toBeVisible();
});

test("a half-filled answer never leaves the phone", async ({ page }) => {
  const fixtures = useGcLinkFunction(page, () => ({ status: 200, json: LIVE }));
  await page.goto(`/gc/${TOKEN}`);

  await page.getByLabel("When do you expect the house to be finished?").fill("2026-11-20");
  await page.getByRole("button", { name: /Send these to the crew/i }).click();

  await expect(page.getByText(/Please say when the roof goes on/i)).toBeVisible();
  expect(fixtures.calls.filter((c) => c.action === "answer")).toHaveLength(0);
});

test("an expired link says one plain sentence and shows nothing else", async ({ page }) => {
  useGcLinkFunction(page, () => ({
    status: 410,
    json: { error: "This link has expired — ask your installer for a new one.", expired: true },
  }));
  await page.goto(`/gc/${TOKEN}`);

  await expect(
    page.getByText(/This link has expired — ask your installer for a new one/i),
  ).toBeVisible();
  // No form, no thread, and NO JOB NAME: a dead token must not confirm that a
  // job by that name exists, or which one this link was for.
  await expect(page.getByLabel("What is going on the outside?")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send these to the crew/i })).toHaveCount(0);
  await expect(page.getByText("Sand Hollow")).toHaveCount(0);
});

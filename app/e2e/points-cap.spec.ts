// The points cap, end to end with mocked routes (2026-09-05).
//
// What this is a net for: a phone used to be able to write the company's
// scoreboard directly, and the Learn tab did — score x 10 straight into
// points_ledger after every round, with no record of which terms it asked and
// an "Another round" button underneath. Two profiles ran up a year's worth of
// points in a day. So the assertions here are about WHAT LEAVES THE BROWSER: an RPC call
// carrying the terms that were asked, and no INSERT anywhere near the ledger.
//
// House style, same as video-quizzes.spec.ts / opening-sheet.spec.ts: mock at
// the network layer, drive the real UI, assert the captured payload a tap
// actually sends rather than that something rendered.
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  jobFixtures,
  openingsFor,
  useSupabaseFixtures,
} from "./support/supabaseFixtures";
import { TERMS } from "../src/lib/glossary";

type Json = Record<string, unknown>;

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** Every term keyed by the description the quiz shows as its prompt, so a test
 * can answer correctly without the page telling it which button is right. */
const TERM_BY_DESC = new Map(TERMS.map((t) => [t.desc, t]));

/**
 * Watch points_ledger for a write. Nothing in the app may POST/PATCH it any
 * more — that is the whole first rule — so every method other than GET is
 * recorded and asserted empty at the end of each test.
 */
async function watchLedgerWrites(page: Page, rows: Json[] = []) {
  const writes: string[] = [];
  await page.route("**/rest/v1/points_ledger**", (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "HEAD") writes.push(method);
    // Honour `status=eq.` the way the real table would, so the leaderboard
    // read (confirmed rows only) and the ledger read see different things —
    // otherwise the mock would hand a voided row to a query that filtered it
    // out, and this test would pass for the wrong reason.
    const status = new URL(route.request().url()).searchParams.get("status") ?? "";
    const wanted = status.startsWith("eq.") ? status.slice(3) : null;
    const out = wanted ? rows.filter((r) => r.status === wanted) : rows;
    return json(route, out, out.length);
  });
  return writes;
}

/** Answer one glossary question correctly and move on. */
async function answerCorrectly(page: Page): Promise<string> {
  const prompt = (await page.locator(".detail-card p").first().innerText()).trim();
  const term = TERM_BY_DESC.get(prompt);
  if (!term) throw new Error(`no glossary term matches the prompt: ${prompt}`);
  await page.getByRole("button", { name: term.term, exact: true }).click();
  await page.getByRole("button", { name: "Next" }).click();
  return `term:${term.id}`;
}

async function useLearnRoutes(
  page: Page,
  opts: {
    progress?: Json;
    award: Json;
    onAward?: (body: Json) => void;
  },
) {
  await page.route("**/rest/v1/rpc/my_education_progress", (route) =>
    json(route, opts.progress ?? { terms_earned: 0, terms_total: 105, sequence_done: false }, 1),
  );
  await page.route("**/rest/v1/rpc/award_education_quiz", (route) => {
    opts.onAward?.(route.request().postDataJSON() as Json);
    return json(route, opts.award, 1);
  });
}

test("a quiz round reports the terms it asked — not a total it worked out itself", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const ledgerWrites = await watchLedgerWrites(page);
  const awards: Json[] = [];
  await useLearnRoutes(page, {
    progress: { terms_earned: 3, terms_total: 105, sequence_done: false },
    award: { points_awarded: 30, new_terms: 3, already_had: 2 },
    onAward: (b) => awards.push(b),
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Quiz" }).click();

  // The header says where the new ground is, off the server's own count.
  await expect(page.getByText("Earned 3 of 105 terms", { exact: false })).toBeVisible();

  const asked: string[] = [];
  for (let i = 0; i < 5; i++) asked.push(await answerCorrectly(page));

  await expect.poll(() => awards.length).toBe(1);
  const sent = awards[0].p_items as { key: string; correct: boolean }[];
  expect(sent.map((i) => i.key)).toEqual(asked);
  expect(sent.every((i) => i.correct)).toBe(true);
  // The payload is the round, and nothing else: no score, no points, no
  // profile id the browser picked for itself.
  expect(Object.keys(awards[0])).toEqual(["p_items"]);
  expect(JSON.stringify(awards[0])).not.toContain("points");

  // What the server said it was worth is what the screen says.
  await expect(page.getByText("+30 points — 3 new terms.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Another round" })).toBeVisible();
  expect(ledgerWrites).toEqual([]);
});

test("a round of terms already earned pays nothing, and says so kindly", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const ledgerWrites = await watchLedgerWrites(page);
  const awards: Json[] = [];
  await useLearnRoutes(page, {
    progress: { terms_earned: 105, terms_total: 105, sequence_done: true },
    // The everyday case now: five terms this person was paid for long ago.
    award: { points_awarded: 0, new_terms: 0, already_had: 5 },
    onAward: (b) => awards.push(b),
  });

  await page.goto("/learn");
  await page.getByRole("button", { name: "Quiz" }).click();
  for (let i = 0; i < 5; i++) await answerCorrectly(page);

  await expect.poll(() => awards.length).toBe(1);
  await expect(
    page.getByText("No new points — you'd already earned these. Keep practising."),
  ).toBeVisible();
  // Practising stays free: the button is still there, it just pays nothing.
  await expect(page.getByRole("button", { name: "Another round" })).toBeVisible();
  expect(ledgerWrites).toEqual([]);
});

test("finishing an install pays through the server, once, and never through the table", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const ledgerWrites = await watchLedgerWrites(page);

  const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
  const real = openingsFor(BLACK22.projectId) as unknown as Json[];
  const o: Json = {
    ...real[1],
    status: "assigned",
    needs_flashing: false,
    work_started_at: "2026-08-20T09:00:00Z",
    confirmed: true,
  };
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      (url.searchParams.get("id") ?? "").startsWith("eq."),
    (route) => json(route, [o], 1),
  );
  await page.addInitScript(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, message: "denied" } as GeolocationPositionError);
    };
    navigator.geolocation.watchPosition = (_ok, err) => {
      err?.({ code: 1, message: "denied", PERMISSION_DENIED: 1 } as GeolocationPositionError);
      return 1;
    };
    navigator.geolocation.clearWatch = () => {};
  });

  await page.route("**/rest/v1/rpc/finish_unit", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "evt-e2e-points-cap" }),
    }),
  );
  const awards: Json[] = [];
  await page.route("**/rest/v1/rpc/award_install_points", (route) => {
    awards.push(route.request().postDataJSON() as Json);
    return json(route, { awarded: 1, already_had: 0 }, 1);
  });

  await page.goto(`/projects/${String(o.project_id)}/opening/${String(o.id)}`);
  await page.getByRole("button", { name: "3. Capture" }).click();
  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles({
      name: "after.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  await page.getByRole("button", { name: "4", exact: true }).click();
  await page.getByRole("button", { name: "Submit install" }).click();

  await expect.poll(() => awards.length).toBe(1);
  expect(awards[0].p_ref).toBe(String(o.id));
  expect(awards[0].p_status).toBe("pending");
  const entries = awards[0].p_entries as { kind: string; points: number }[];
  expect(entries.map((e) => e.kind)).toContain("install");
  // The outbox never reaches for the table itself any more.
  expect(ledgerWrites).toEqual([]);
});

test("the Points page totals confirmed rows and leaves the voided ones out", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  // One of each: earned, waiting on QC, and one of the farmed quiz rows the
  // migration voided. Only the first counts toward the number on the hero.
  await watchLedgerWrites(page, [
    {
      id: "l1", profile_id: "e2e", kind: "install", points: 20,
      status: "confirmed", ref: "opening-1", created_at: "2026-09-01T10:00:00Z",
    },
    {
      id: "l2", profile_id: "e2e", kind: "install", points: 15,
      status: "pending", ref: "opening-2", created_at: "2026-09-02T10:00:00Z",
    },
    {
      id: "l3", profile_id: "e2e", kind: "quiz", points: 9999,
      status: "void", ref: null, created_at: "2026-09-03T10:00:00Z",
      void_reason: "education quiz rows before the new-content rule (2026-09-05)",
    },
  ]);

  await page.goto("/points");
  await expect(page.locator(".points-total")).toHaveText("20");
  await expect(page.locator(".points-mini.warn strong")).toHaveText("15");
  await expect(page.getByText("9999")).toHaveCount(0);
  // And the rule the page states is the rule the server now enforces.
  await expect(
    page.getByText("the first time you get a term right", { exact: false }),
  ).toBeVisible();
});

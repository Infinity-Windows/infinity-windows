// Clock in once (owner ask, 2026-09-06).
//
// "Whenever my guys clock in, they have to do the same thing twice: select a
// project twice, a cost code twice, and click clock in twice. Fix this so it
// only happens once and immediately brings up the toolbox talk."
//
// Two things this proves against the real landing rather than a unit test:
//
//   1. an installer whose talk is unsigned picks a job and a cost code on the
//      landing block and taps the ONE big button — and the next thing on the
//      screen is today's toolbox talk, right there in the block. Not a second
//      "Where are you working?" sheet with its own empty job list and cost-code
//      list to fill in again;
//   2. signing the talk (pledge, typed name, a drawn stroke, "Sign today's
//      talk") is the last tap: exactly ONE clock_in request leaves the phone,
//      carrying the job and the cost code the person picked on the landing.
//
// WHY THIS IS RED on master (b6709ae) — the two lines that make it so:
//   ClockInBlock.tsx:607  the held button's only action is
//                         onClick={openClockGlobally}, and
//   clockContext.tsx:119  openClockGlobally dispatches a bare `new Event(...)`
//                         with no payload,
// so the tap opens the full ClockSheet, which owns fresh empty pickers primed
// from recents[0] (BLACK22 here — the WRONG job for this morning), and the
// person picks OAKRIDGE and the cost code again, signs, and taps Start clock
// again. Assertion 1 fails the moment the sheet appears.
//
// The recents, the talk, the cost codes and the shift are hand-built rather
// than captured, because the whole point is a specific geometry: the most
// recent job is NOT the job this person is going to today.

import { expect, test, type Page } from "@playwright/test";
import { useSupabaseFixtures } from "./support/supabaseFixtures";
import {
  dayISO,
  hideWrongProjectBanner,
  json,
  stubGeolocationDenied,
} from "./support/specHelpers";

/** The two fixture jobs this spec uses, by their real fixture ids. */
const BLACK22 = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
const OAKRIDGE = "3cc5b810-45e0-4445-a115-efa98f8efad3";

const GENERAL = "11111111-aaaa-4aaa-8aaa-111111111111";
const INSTALL = "22222222-bbbb-4bbb-8bbb-222222222222";

const COST_CODES = [
  {
    id: GENERAL,
    code: "000",
    label: "General",
    description: null,
    active: true,
    sort_order: 5,
    is_general: true,
  },
  {
    id: INSTALL,
    code: "100",
    label: "Install — windows",
    description: null,
    active: true,
    sort_order: 10,
    is_general: false,
  },
];

const TALK_ID = "33333333-cccc-4ccc-8ccc-333333333333";
const TALK = {
  id: TALK_ID,
  title: "Ladders",
  body: "Three points of contact. Inspect before you climb.",
  talk_date: dayISO(0),
  key_points: ["Three points of contact", "Inspect the rungs and feet"],
  watch_for: ["Wet rungs"],
  stop_work_line: "A cracked rail is a stop-work.",
  pledge: null,
  created_at: `${dayISO(0)}T06:00:00Z`,
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/**
 * Yesterday's punch was BLACK22 on the General code, so recents[0] — the job
 * the landing block primes itself with — is the WRONG job for this morning.
 */
const RECENT_SHIFTS = [
  {
    project_id: BLACK22,
    cost_code_id: GENERAL,
    clock_in_at: hoursAgo(26),
    projects: { job_code: "BLACK22", name: "Black Desert" },
  },
];

interface ClockInCall {
  body: Record<string, unknown>;
}

/**
 * Registered AFTER useSupabaseFixtures so these win (Playwright favours the
 * most recently added route). Returns the list the clock_in calls land in, so
 * the test can assert what actually left the phone — and how many times.
 */
async function morningFixtures(page: Page): Promise<ClockInCall[]> {
  const clockIns: ClockInCall[] = [];
  let signed: Record<string, unknown> | null = null;
  let openShift: Record<string, unknown> | null = null;

  // Today's talk exists and is unsigned. The block reads the talk with
  // maybeSingle (an object); anything list-shaped gets the same talk in a list.
  await page.route("**/rest/v1/safety_talks**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, TALK, 1);
    return json(r, [TALK], 1);
  });

  // Signing inserts the completion; from then on "did I sign today?" is yes.
  await page.route("**/rest/v1/toolbox_completions**", (r) => {
    if (r.request().method() === "POST") {
      const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
      signed = {
        id: "44444444-dddd-4ddd-8ddd-444444444444",
        ...body,
        signed_at: new Date().toISOString(),
        source: "self",
      };
      return json(r, signed, 1);
    }
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, signed, signed ? 1 : 0);
    return json(r, signed ? [signed] : [], signed ? 1 : 0);
  });

  // The signature PNG and the archived PDF go to storage before the row is
  // written; the shared fixture answers 404 there, which would fail the sign.
  await page.route("**/storage/v1/object/toolbox-records/**", (r) =>
    json(r, { Key: "toolbox-records/e2e" }, null),
  );

  // One table, two readers: the open-shift lookup and the recent-jobs list.
  // Told apart by the URL, not the Accept header — postgrest-js sends a GET
  // maybeSingle() as plain application/json and takes the first row itself,
  // so answering the recents list to the open-shift lookup would make
  // yesterday's punch look like a shift still running. Off the clock until
  // the RPC below says otherwise.
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const url = new URL(r.request().url());
    if ((url.searchParams.get("status") ?? "").startsWith("in.")) {
      return json(r, openShift ? [openShift] : [], openShift ? 1 : 0);
    }
    return json(r, RECENT_SHIFTS, RECENT_SHIFTS.length);
  });

  await page.route("**/rest/v1/cost_codes**", (r) =>
    json(r, COST_CODES, COST_CODES.length),
  );
  // No per-job subset: the whole active library is pickable on every job.
  await page.route("**/rest/v1/project_cost_codes**", (r) => json(r, [], 0));

  // The punch itself. Counted, and it turns the person "on the clock".
  await page.route(
    (url) => /\/rest\/v1\/rpc\/clock_in(\?|$)/.test(url.href),
    (r) => {
      const body = (r.request().postDataJSON() ?? {}) as Record<string, unknown>;
      clockIns.push({ body });
      openShift = {
        id: "55555555-eeee-4eee-8eee-555555555555",
        profile_id: "00000000-0000-4000-8000-0000000000e2",
        project_id: body.p_project_id ?? null,
        cost_code_id: body.p_cost_code_id ?? null,
        clock_in_at: new Date().toISOString(),
        clock_out_at: null,
        break_seconds: 0,
        break_started_at: null,
        break_type: null,
        injured: null,
        time_confirmed: null,
        status: "open",
        created_at: new Date().toISOString(),
        note: body.p_note ?? null,
        clocked_in_by: null,
        clocked_out_by: null,
        projects: { job_code: "OAKRIDGE", name: "Oakridge Apartments Bldg C" },
        cost_codes: { code: "100", label: "Install — windows" },
        profiles: { display_name: "E2E Fixture" },
        editor: null,
        voider: null,
      };
      return json(r, openShift, null);
    },
  );

  return clockIns;
}

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

test("pick once, tap once: the talk comes up in the block and signing it is the clock-in", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const clockIns = await morningFixtures(page);

  await page.goto("/");
  const block = page.locator(".clockin-block");
  await expect(block).toBeVisible();

  // The block primed itself with yesterday's job. This morning is a different
  // one: open the full list, tap OAKRIDGE, then tap the install code.
  await expect(block.locator(".clock-chip.current")).toContainText("BLACK22");
  await block.getByRole("button", { name: "Choose a different job" }).click();
  await block.locator(".clock-project-item", { hasText: "OAKRIDGE" }).click();
  await block.locator(".clock-costcode-item", { hasText: "100 — Install — windows" }).click();
  await expect(block.locator(".clock-costcode-item.selected")).toContainText("Install — windows");

  // ONE tap on the big button.
  const big = block.locator(".clock-btn.primary.big");
  await expect(big).toHaveText(/Sign safety talk & clock in/);
  await expect(big).toBeEnabled();
  await big.click();

  // (1) The next thing on screen is today's talk, IN the block — not a second
  //     "Where are you working?" sheet with its own job list and cost codes.
  await expect(page.locator(".clock-sheet")).toHaveCount(0);
  await expect(page.getByText("Where are you working?")).toHaveCount(0);
  await expect(block.getByText("Today's toolbox talk")).toBeVisible();
  await expect(block.getByText("Ladders")).toBeVisible();
  // Exactly one job list and one cost-code list on the page: the block's own.
  await expect(page.locator(".clock-costcode-list")).toHaveCount(1);
  expect(clockIns).toHaveLength(0);

  // (2) Sign it: pledge, typed name, a drawn stroke, "Sign today's talk".
  await block.getByText("I read and understood today's talk").click();
  await block.getByPlaceholder("Full name").fill("E2E Fixture");
  const pad = block.locator("canvas.sig-canvas");
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2 + 10, { steps: 8 });
  await page.mouse.up();
  const signBtn = block.getByRole("button", { name: "Sign today's talk" });
  await expect(signBtn).toBeEnabled();
  await signBtn.click();

  // No further tap: the punch leaves on its own, once, carrying the landing's
  // picks — OAKRIDGE and the install code, not recents[0]'s BLACK22/General.
  await expect.poll(() => clockIns.length).toBe(1);
  expect(clockIns[0].body.p_project_id).toBe(OAKRIDGE);
  expect(clockIns[0].body.p_cost_code_id).toBe(INSTALL);

  // And the landing settles into the on-the-clock bar for that job.
  await expect(page.locator(".clockin-bar")).toContainText("OAKRIDGE");
  expect(clockIns).toHaveLength(1);
});

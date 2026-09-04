// The Jobs page cards line up, whoever is looking and whatever is on them.
//
// The bug this exists to stop coming back: `.home-project-head` was a flex row
// with `justify-content: space-between` and a middle child that did not grow.
// Three children and space-between means the free space goes BETWEEN the items
// — so a card whose text was short had that text pushed toward the middle of
// the card, while a card with a long scope line stayed hard left. Scrolling the
// list, the job names walked left and right from card to card. The reorder rail
// added a second offset, because it only renders for foreman and up.
//
// So the check is a measurement, not a look: every card's text block must start
// at the SAME x, on a phone and on a laptop, as somebody who can reorder the
// list and as somebody who cannot. The jobs below are deliberately of three
// different heights (four text lines, three, two) and the first and last cards
// are the ones with the disabled reorder buttons, which is where a width that
// depends on what is rendered would show up first.
//
// It also drops a picture per role and width into e2e/__screenshots__/job-cards
// for a human to eyeball. Those are throwaway, like every other screenshot this
// suite writes — see __screenshots__/README.md.

import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { useSupabaseFixtures } from "./support/supabaseFixtures";

const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), "__screenshots__/job-cards");

const LONG_ID = "dddddddd-1111-4111-8111-dddddddddddd";
const TRACK_ID = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";
const SHORT_ID = "ffffffff-3333-4333-8333-ffffffffffff";

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Wave H keeps readiness and the materials dates in `project_pipeline`, and
 *  the app reads them as a PostgREST embed — so the fixture nests them. */
function project(over: Record<string, unknown> & { pipeline?: Record<string, unknown> }) {
  const { pipeline, ...rest } = over;
  return {
    address: null,
    status: "active",
    is_test: false,
    allowed_modes: ["data"],
    start_date: null,
    stories: null,
    sort_order: null,
    ...rest,
    project_pipeline: {
      ready_state: "ready",
      materials_eta: null,
      materials_arrived_at: null,
      ...(pipeline ?? {}),
    },
  };
}

// The tall one: name + two badges + a chip, a long address, a full scope line
// and a full pipeline line. Four lines of text.
const LONG = project({
  id: LONG_ID,
  job_code: "MADMOOSE",
  name: "Mad Moose",
  address: "4821 Wandering Elk Trail, Heber City",
  stories: 2,
  start_date: day(10),
  pipeline: { ready_state: "not_ready", materials_eta: day(4) },
  sort_order: 1,
});

// The short one: a tracking job says "Tracking job" and nothing else. Three
// lines, and no pipeline line at all.
const TRACKING = project({
  id: TRACK_ID,
  job_code: "OFFICEMTG",
  name: "Office-Meetings",
  allowed_modes: ["tracking"],
  sort_order: 2,
});

// The last card, and the one with nothing counted yet: no scope line renders
// at all, so it is two lines tall. Its "move down" button is disabled, which is
// where a rail that sized itself to its contents would drift.
const SHORT = project({
  id: SHORT_ID,
  job_code: "TESTING1234",
  name: "Testing 1234",
  sort_order: 3,
});

const COUNTS = [
  {
    project_id: LONG_ID,
    openings: 40,
    installed: 32,
    windows: 32,
    doors: 8,
    door_sliders: 5,
    door_french: 2,
    door_bifold: 1,
    door_swing: 0,
    door_other: 0,
    unknown_units: 0,
  },
];

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** Registered AFTER useSupabaseFixtures so these win — Playwright favours the
 *  most recently added route. */
async function useCardFixtures(page: Page) {
  const rows = [LONG, TRACKING, SHORT];
  await page.route("**/rest/v1/projects**", (r) => json(r, rows, rows.length));
  await page.route("**/rest/v1/project_scope_counts**", (r) => json(r, COUNTS, COUNTS.length));
  // Nobody has called anybody, so "Needs a call" lights on every card — the
  // widest the name row ever gets, which is the row worth measuring.
  await page.route("**/rest/v1/project_gc_checkins**", (r) => json(r, [], 0));
  await page.route("**/rest/v1/project_plan_outlines**", (r) => json(r, [], 0));
}

/** The left edge of every card's text block, in page coordinates. */
async function textEdges(page: Page): Promise<number[]> {
  return page.locator("a.project-card .job-card-body").evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().left * 10) / 10),
  );
}

async function shoot(page: Page, label: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${label}.png`), fullPage: true });
}

/**
 * What each width's foreman run measured, so the installer run below can check
 * it against the same number. The config runs this file in one worker with
 * `fullyParallel: false`, so the foreman test has always finished by then;
 * running one test on its own just leaves this empty and skips the comparison.
 */
const foremanEdge = new Map<number, number>();

for (const width of [390, 1024] as const) {
  for (const role of ["foreman", "installer"] as const) {
    test.describe(`${width}px, ${role}`, () => {
      test.use({ viewport: { width, height: 844 }, deviceScaleFactor: 2 });

      test(`every job card starts its text at the same place (${width}px, ${role})`, async ({
        page,
      }) => {
        // Inline rather than behind a helper: the fixture setters read as React
        // hooks to the linter, and it only forgives them inside a test body.
        await useSupabaseFixtures(page, { role });
        await useCardFixtures(page);
        await page.goto("/projects");
        await expect(page.locator("a.project-card")).toHaveCount(3);
        await expect(page.locator("a.project-card").first()).toContainText("Mad Moose");

        // Taken before the assertion on purpose, so a failing run still leaves
        // the picture that explains it.
        await shoot(page, `${width}-${role}`);

        const edges = await textEdges(page);
        expect(edges).toHaveLength(3);
        // THE POINT: one number, three cards. A tracking job with two lines
        // starts exactly where a data job with four does.
        expect(new Set(edges).size).toBe(1);

        // And the reorder rail is only the difference between the roles, not
        // between the cards: foreman gets three rails, an installer none.
        await expect(page.locator(".job-order-rail .job-order-btn")).toHaveCount(
          role === "foreman" ? 6 : 0,
        );

        // THE OTHER POINT: the rail's column is RESERVED whether or not the
        // rail is in it, so an installer's job names start on exactly the same
        // pixel a foreman's do — the two roles read one list, not two.
        if (role === "foreman") foremanEdge.set(width, edges[0]);
        else {
          const theirs = foremanEdge.get(width);
          if (theirs !== undefined) expect(edges[0]).toBe(theirs);
        }
      });
    });
  }
}

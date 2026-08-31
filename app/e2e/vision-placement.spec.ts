// Wave V-A: vision placement. Same house style as receipts.spec.ts — mocked
// routes, real UI, assert the CAPTURED payload a tap actually sends rather
// than just that something rendered.
//
// Uses OAKRIDGE's real building planset (a real PDF from the storage backup,
// via useSupabaseFixtures) so the client's own floor-plan-page detection
// (findFloorPlanPages) runs against a real document, same as production.
// extract-placement's own vision call is mocked — there is no live AI in
// this suite — with a fixed reply naming one mark, "C102".
//
// The synthetic outline below carries an AUTHORED model (features.fitview.
// model) whose windows[] already lists "C102", the same technique wave
// V-B's maps-unplaced-marks.spec.ts uses: buildAuthoredJob only needs
// footprints + windows to be arrays, never a traced polygon or a real pin,
// so a suggestion for a mark with no pin yet still has somewhere to land in
// the tracer's own JOB.windows.
import { expect, test, type Route } from "@playwright/test";
import {
  jobFixtures,
  useSupabaseFixtures,
} from "./support/supabaseFixtures";

const OAKRIDGE = jobFixtures().find((j) => j.jobCode === "OAKRIDGE")!;
const WINDOW_TYPE_ID = "4bf401a9-a166-4185-8f75-49142ccf585e";

const MODEL = {
  building: {
    width: 10,
    depth: 6,
    height: 3,
    rise: 0,
    footprints: [
      [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
        { x: 10, z: 6 },
        { x: 0, z: 6 },
      ],
    ],
  },
  // "C102" has no elev/x placement worth trusting yet — same as any window
  // the trace tool has never touched — but it exists, which is the one
  // thing a suggestion needs to have somewhere to land.
  windows: [{ id: "C102", elev: "", x: 0, w: 900, h: 1300 }],
};

function json(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

interface OpeningState {
  id: string;
  project_id: string;
  opening_code: string;
  window_type_id: string;
  label: string | null;
  page_number: number;
  pin_x: number | null;
  pin_y: number | null;
  suggested_pin_x: number | null;
  suggested_pin_y: number | null;
  suggested_page_number: number | null;
  suggested_confidence: number | null;
  suggested_at: string | null;
  status: string;
  confirmed: boolean;
  assigned_to: string | null;
  assignee: unknown;
  window_types: unknown;
}

function makeOpening(): OpeningState {
  return {
    id: "10000000-0000-4000-8000-000000000c02",
    project_id: OAKRIDGE.projectId,
    opening_code: "C102",
    window_type_id: WINDOW_TYPE_ID,
    label: "Unit C102 living",
    page_number: 1,
    pin_x: null,
    pin_y: null,
    suggested_pin_x: null,
    suggested_pin_y: null,
    suggested_page_number: null,
    suggested_confidence: null,
    suggested_at: null,
    status: "planned",
    confirmed: true,
    assigned_to: null,
    assignee: null,
    window_types: { id: WINDOW_TYPE_ID, name: "Double-Hung 32x52" },
  };
}

test("Find placements suggests a dashed dot, and Confirm all writes a real pin", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });

  let opening = makeOpening();
  const placementCalls: Record<string, unknown>[] = [];
  const applyCalls: Record<string, unknown>[] = [];
  const patches: { id: string; patch: Record<string, unknown> }[] = [];

  await page.route("**/rest/v1/project_openings**", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const url = new URL(req.url());
      const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
      const patch = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      patches.push({ id, patch });
      if (id === opening.id) opening = { ...opening, ...patch };
      return json(route, opening, 1);
    }
    return json(route, [opening], 1);
  });

  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    json(
      route,
      [
        {
          id: "20000000-0000-4000-8000-00000000ab01",
          project_id: OAKRIDGE.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model: MODEL } },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      1,
    ),
  );

  await page.route("**/functions/v1/extract-placement**", async (route) => {
    placementCalls.push(
      (route.request().postDataJSON() ?? {}) as Record<string, unknown>,
    );
    await json(route, {
      placements: [{ mark: "C102", page: 1, x: 0.5, y: 0.4, confidence: 0.85 }],
      unknownMarks: [],
      failedPages: [],
      mode: "vision",
    });
  });

  await page.route(
    "**/rest/v1/rpc/apply_placement_suggestions**",
    async (route) => {
      const body = (route.request().postDataJSON() ?? {}) as {
        p_suggestions?: { opening_id: string; x: number; y: number; page: number; confidence: number }[];
      };
      applyCalls.push(body);
      let applied = 0;
      for (const s of body.p_suggestions ?? []) {
        if (s.opening_id === opening.id && opening.pin_x == null) {
          opening = {
            ...opening,
            suggested_pin_x: s.x,
            suggested_pin_y: s.y,
            suggested_page_number: s.page,
            suggested_confidence: s.confidence,
            suggested_at: new Date().toISOString(),
          };
          applied++;
        }
      }
      return json(route, applied);
    },
  );

  await page.goto(`/projects/${OAKRIDGE.projectId}/trace-model`);
  await expect(page.getByRole("heading", { name: "Trace 3D model" })).toBeVisible();

  const findBtn = page.getByRole("button", { name: "Find placements" });
  await expect(findBtn).toBeVisible({ timeout: 30_000 });
  await findBtn.click();

  // extract-placement is asked about C102 (the only unplaced mark) — never a
  // mark that already has a real pin (CAD-WINS / the rescan law, enforced
  // client-side too before a single mark ever reaches the vision call).
  await expect.poll(() => placementCalls.length, { timeout: 30_000 }).toBe(1);
  const marks = placementCalls[0].marks as { code: string }[];
  expect(marks.map((m) => m.code)).toEqual(["C102"]);

  await expect.poll(() => applyCalls.length).toBe(1);
  expect(applyCalls[0].p_suggestions).toEqual([
    { opening_id: opening.id, x: 0.5, y: 0.4, page: 1, confidence: 0.85 },
  ]);

  // The suggested (dashed) dot for C102 is now on the sheet.
  const suggestedDot = page.locator('[data-sugg="C102"]');
  await expect(suggestedDot).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-dot="C102"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Confirm all" }).click();

  // Confirming graduates the dashed dot into a real, solid one on the sheet…
  await expect(page.locator('[data-dot="C102"]')).toBeVisible();
  await expect(suggestedDot).toHaveCount(0);

  // …and writes the REAL pin (never the suggested fields) to the database,
  // clearing the suggestion so a rescan won't touch this mark again.
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0].id).toBe(opening.id);
  expect(patches[0].patch).toMatchObject({
    pin_x: 0.5,
    pin_y: 0.4,
    page_number: 1,
    suggested_pin_x: null,
    suggested_pin_y: null,
    suggested_page_number: null,
    suggested_at: null,
    suggested_confidence: null,
  });
});

test("dismissing a suggestion clears it without writing a pin", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });

  let opening = makeOpening();
  opening.suggested_pin_x = 0.6;
  opening.suggested_pin_y = 0.3;
  opening.suggested_page_number = 1;
  opening.suggested_confidence = 0.7;
  opening.suggested_at = "2026-08-30T00:00:00Z";
  const patches: { id: string; patch: Record<string, unknown> }[] = [];

  await page.route("**/rest/v1/project_openings**", async (route) => {
    const req = route.request();
    if (req.method() === "PATCH") {
      const url = new URL(req.url());
      const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
      const patch = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      patches.push({ id, patch });
      if (id === opening.id) opening = { ...opening, ...patch };
      return json(route, opening, 1);
    }
    return json(route, [opening], 1);
  });

  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    json(
      route,
      [
        {
          id: "20000000-0000-4000-8000-00000000ab02",
          project_id: OAKRIDGE.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { fitview: { model: MODEL } },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      1,
    ),
  );

  await page.goto(`/projects/${OAKRIDGE.projectId}/trace-model`);
  const suggestedDot = page.locator('[data-sugg="C102"]');
  await expect(suggestedDot).toBeVisible({ timeout: 30_000 });

  // Tap (not drag) selects the suggestion for Dismiss rather than confirming
  // it — a stray tap must never place a window.
  await suggestedDot.click();
  await page.getByRole("button", { name: "Dismiss" }).click();

  await expect(suggestedDot).toHaveCount(0);
  await expect(page.locator('[data-dot="C102"]')).toHaveCount(0);

  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0].patch).toMatchObject({
    suggested_pin_x: null,
    suggested_pin_y: null,
    suggested_page_number: null,
    suggested_at: null,
    suggested_confidence: null,
  });
  // Dismiss never touches the real pin — that is what leaves the mark free
  // for the next Find placements run to suggest again.
  expect(patches[0].patch.pin_x).toBeUndefined();
  expect(patches[0].patch.pin_y).toBeUndefined();
});

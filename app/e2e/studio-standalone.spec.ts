// The Studio's new front door and single-stage editor: the list unions
// standalone projects with job models, a blank project boots straight into
// an editable empty plan, the stage shows ONE view with the 2D/3D dropdown
// (3D is home), and the tools palette rides on BOTH views — the owner's
// screenshot showed a fullscreen 3D pane with no tools at all.

import { expect, test, type Page, type Route } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;
const SP1 = "00000000-0000-4000-8000-00000000d001";

const STUDIO_ROWS = [
  {
    id: SP1,
    name: "Spec house concept",
    project_id: null,
    model: null,
    archived: false,
    created_by: "e2e",
    created_at: "2026-08-13T00:00:00Z",
    updated_at: "2026-08-13T00:00:00Z",
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

async function useStudioFixtures(page: Page) {
  const calls: { fn: string; body: unknown }[] = [];
  await page.route("**/rest/v1/studio_projects**", (r) => {
    const single = (r.request().headers()["accept"] ?? "").includes("pgrst.object");
    return single ? json(r, STUDIO_ROWS[0], 1) : json(r, STUDIO_ROWS, STUDIO_ROWS.length);
  });
  await page.route("**/rest/v1/rpc/save_studio_project", (r) => {
    calls.push({ fn: "save_studio_project", body: r.request().postDataJSON() });
    return json(r, { ...STUDIO_ROWS[0], name: "4-plex concept" }, 1);
  });
  return calls;
}

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

test("the list unions standalone projects with job models", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useStudioFixtures(page);
  // BLACK22's outline carries a saved studio model in this fixture.
  await page.route("**/rest/v1/project_plan_outlines**", (r) =>
    json(
      r,
      [
        {
          id: "00000000-0000-4000-8000-00000000e001",
          project_id: BLACK22.projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: { modelstudio: { serialized: "{}", savedAt: "2026-08-12T00:00:00Z" } },
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-12T00:00:00Z",
        },
      ],
      1,
    ),
  );
  await page.goto("/studio");

  await expect(page.getByText("Spec house concept")).toBeVisible();
  await expect(page.getByText(/BLACK22 — /)).toBeVisible();
  await expect(page.getByText("Job model")).toBeVisible();
});

test("a blank project boots editable, defaults to 3D, and keeps tools in 3D", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useStudioFixtures(page);
  await page.goto(`/studio/p/${SP1}`);

  // Boots to the 3D view with the palette available.
  await expect(page.getByText("Model (3D)")).toBeVisible();
  await expect(page.getByRole("button", { name: /Tools/ })).toBeVisible();
  await expect(page.getByText(/Blank slate/)).toBeVisible();

  // The unlinked project offers the link-to-job select and no publish gate.
  await expect(page.getByLabel("Link to job")).toBeVisible();

  // The vendor booted an EMPTY plan (no walls) and __studio is live.
  const walls = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp ? bp.model.floorplan.getWalls().length : -1;
  });
  expect(walls).toBe(0);

  // Dropdown swaps to 2D — the plan header + zoom controls appear.
  await page.getByLabel("View").selectOption("plan");
  await expect(page.getByText("Plan (2D)")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fit" })).toBeVisible();
  // Tools stay present in 2D too.
  await expect(page.getByRole("button", { name: /Tools/ })).toBeVisible();

  // And back to 3D.
  await page.getByLabel("View").selectOption("model");
  await expect(page.getByText("Model (3D)")).toBeVisible();
});

test("creating a project calls the RPC and opens the editor", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const calls = await useStudioFixtures(page);
  await page.goto("/studio");

  await page.getByRole("button", { name: "New project" }).click();
  await page.getByPlaceholder(/Spec house/).fill("4-plex concept");
  await page.getByRole("button", { name: "Create & open" }).click();

  await expect.poll(() => calls.length).toBe(1);
  const body = calls[0].body as { p_name: string; p_id: string | null };
  expect(body.p_name).toBe("4-plex concept");
  expect(body.p_id).toBeNull();
  await expect(page).toHaveURL(new RegExp(`/studio/p/${SP1}`));
});

test("floors: add empty floor 2, ghost + ceiling appear, save carries both", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  const calls = await useStudioFixtures(page);
  await page.goto(`/studio/p/${SP1}`);
  await expect(page.getByText("Model (3D)")).toBeVisible();

  // Give floor 1 a real footprint (programmatic — drawing is tested by hand).
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const fp = bp.model.floorplan;
    const a = fp.newCorner(0, 0, "a");
    const b = fp.newCorner(1000, 0, "b");
    const c = fp.newCorner(1000, 600, "c");
    const d = fp.newCorner(0, 600, "d");
    fp.newWall(a, b);
    fp.newWall(b, c);
    fp.newWall(c, d);
    fp.newWall(d, a);
    fp.update();
  });

  // Tools → Building → + Floor → Start empty.
  await page.getByRole("button", { name: /Tools/ }).click();
  await page.getByText("Building", { exact: true }).click();
  await page.getByRole("button", { name: "+ Floor" }).click();
  await page.getByRole("button", { name: "Start empty" }).click();

  // Floor 2 active: chip state + the hint + the ghost underlay in 2D.
  await expect(
    page.getByText(/the floor below shows as a ghost/),
  ).toBeVisible();
  const state = await page.evaluate(() => {
    const bp = (window as any).__studio;
    const scene = bp.model.scene.getScene();
    const shells = scene.children.filter((g: any) => g.name === "studio-floor-shell");
    return {
      activeWalls: bp.model.floorplan.getWalls().length,
      shells: shells.length,
      // Floor 1's shell = 4 wall quads + 1 ceiling lid.
      shellChildren: shells[0]?.children.length ?? 0,
      ghost: bp.floorplanner?.view?.underlayWalls?.length ?? 0,
    };
  });
  expect(state.activeWalls).toBe(0); // empty — NOT a copy of floor 1
  expect(state.shells).toBe(1);
  expect(state.shellChildren).toBe(5);
  expect(state.ghost).toBe(4);

  // Back to floor 1: ghost gone, floor 1's walls live again.
  await page.getByRole("button", { name: "1", exact: true }).click();
  const back = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return {
      activeWalls: bp.model.floorplan.getWalls().length,
      ghost: bp.floorplanner?.view?.underlayWalls?.length ?? 0,
    };
  });
  expect(back.activeWalls).toBe(4);
  expect(back.ghost).toBe(0);

  // Save: the RPC body carries BOTH floors.
  await page.getByRole("button", { name: "Save model" }).click();
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  const body = calls[calls.length - 1].body as {
    p_model: { floors: string[]; serialized: string };
  };
  expect(body.p_model.floors).toHaveLength(2);
  expect(body.p_model.serialized).toBe(body.p_model.floors[0]);
});

test("copy-floor-below duplicates the plan for hotel repeats", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useStudioFixtures(page);
  await page.goto(`/studio/p/${SP1}`);
  await expect(page.getByText("Model (3D)")).toBeVisible();
  await page.evaluate(() => {
    const bp = (window as any).__studio;
    const fp = bp.model.floorplan;
    const a = fp.newCorner(0, 0, "a");
    const b = fp.newCorner(800, 0, "b");
    const c = fp.newCorner(800, 500, "c");
    const d = fp.newCorner(0, 500, "d");
    fp.newWall(a, b);
    fp.newWall(b, c);
    fp.newWall(c, d);
    fp.newWall(d, a);
    fp.update();
  });
  await page.getByRole("button", { name: /Tools/ }).click();
  await page.getByText("Building", { exact: true }).click();
  await page.getByRole("button", { name: "+ Floor" }).click();
  await page.getByRole("button", { name: "Copy floor below" }).click();
  const walls = await page.evaluate(() => {
    const bp = (window as any).__studio;
    return bp.model.floorplan.getWalls().length;
  });
  expect(walls).toBe(4); // identical plan, ready to adjust
});

test("old job-tab links land on the standalone Studio", async ({ page }) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useStudioFixtures(page);
  await page.goto(`/projects/${BLACK22.projectId}?tab=model-studio`);
  await expect(page).toHaveURL(new RegExp(`/studio/j/${BLACK22.projectId}`));
});

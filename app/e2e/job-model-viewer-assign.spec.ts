// Tap-to-assign in 3D (Studio 100x #8): the JobModelViewer port of the
// fit-view map's own Assign mode (see map-assign.spec.ts). A foreman taps
// units on the LOADED 3D MODEL — not the flat map's real DOM buttons — so
// this drives real pointer events at camera-projected screen coordinates,
// the same technique studio-holes.spec.ts already proves for this vendored
// engine, through a `window.__jobModelViewer` debug handle mirroring
// ModelStudio's own `window.__studio`.
import { expect, test } from "@playwright/test";
import { jobFixtures, openingsFor, useSupabaseFixtures } from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/**
 * A minimal 10x6m room (plan cm, same corner shape as studio-holes.spec.ts's
 * own MASS_A) with two windows on the south wall, carrying REAL fixture mark
 * codes ("10"/"11") so tapping them resolves to real opening UUIDs. Items are
 * embedded directly in the serialized JSON — the vendor's own
 * StudioSerializedItem shape (see aiAssist.test.ts's `item()` fixture) —
 * rather than added live, since JobModelViewer only ever loads a saved
 * serialized model; it never calls addItem itself.
 */
function twoWindowRoomSerialized(): string {
  const corners = {
    a: { x: 0, y: 0 },
    b: { x: 1000, y: 0 },
    c: { x: 1000, y: 600 },
    d: { x: 0, y: 600 },
  };
  const ids = Object.keys(corners);
  const unitConfig = {
    kind: "window",
    heightMm: 1500,
    panels: [{ widthMm: 1200, mechanism: "fixed" }],
  };
  const item = (name: string, x: number) => ({
    item_name: name,
    item_type: 3,
    model_url: "/modelstudio/models/window.json",
    xpos: x,
    ypos: 120,
    zpos: 600,
    rotation: 0,
    scale_x: 1,
    scale_y: 1,
    scale_z: 1,
    fixed: false,
    metadata: { itemName: name, unitConfig },
  });
  return JSON.stringify({
    floorplan: {
      corners,
      walls: ids.map((id, i) => ({ corner1: id, corner2: ids[(i + 1) % 4] })),
      wallTextures: [],
      floorTextures: {},
      newFloorTextures: {},
    },
    items: [item("10", 300), item("11", 700)],
  });
}

async function useModelOutline(page: import("@playwright/test").Page, projectId: string) {
  await page.route("**/rest/v1/project_plan_outlines**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "content-range": "0-0/1" },
      body: JSON.stringify([
        {
          id: "00000000-0000-4000-8000-0000000a5528",
          project_id: projectId,
          planset_id: null,
          page_number: 1,
          points: [],
          page_aspect: 0.7,
          features: {
            modelstudio: {
              serialized: twoWindowRoomSerialized(),
              savedAt: "2026-08-20T00:00:00Z",
            },
          },
          created_at: "2026-08-20T00:00:00Z",
          updated_at: "2026-08-20T00:00:00Z",
        },
      ]),
    }),
  );
}

/** World -> CSS pixels inside the 3D pane, via the live camera — same
 * projection technique studio-holes.spec.ts uses for the Studio's own
 * `window.__studio`, aimed at this viewer's `window.__jobModelViewer`. */
async function tapWorldPoint(
  page: import("@playwright/test").Page,
  x: number,
  y: number,
  z: number,
) {
  await page.evaluate(
    ([wx, wy, wz]) => {
      const bp = (window as any).__jobModelViewer;
      const cam = bp.three.camera;
      cam.updateMatrixWorld();
      const v = new (bp.three.camera.position.constructor)(wx, wy, wz);
      v.project(cam);
      const r = bp.three.element.getBoundingClientRect();
      const px = r.left + ((v.x + 1) / 2) * r.width;
      const py = r.top + ((1 - v.y) / 2) * r.height;
      const opts = {
        bubbles: true,
        clientX: px,
        clientY: py,
        pointerId: 1,
        isPrimary: true,
        button: 0,
      };
      bp.three.element.dispatchEvent(new PointerEvent("pointerdown", opts));
      bp.three.element.dispatchEvent(new PointerEvent("pointerup", opts));
    },
    [x, y, z] as [number, number, number],
  );
}

test("viewer assign: tap units in order, pick a person, sequenced RPCs fire in tap order", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "supervisor" });
  await useModelOutline(page, BLACK22.projectId);

  const assigns: { opening: string; profile: string; sequence: number }[] = [];
  await page.route("**/rest/v1/rpc/assign_opening_to_installer", async (route) => {
    const body = route.request().postDataJSON() as {
      p_opening_id: string;
      p_profile_id: string;
      p_sequence: number;
    };
    assigns.push({
      opening: body.p_opening_id,
      profile: body.p_profile_id,
      sequence: body.p_sequence,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await page.goto(`/projects/${BLACK22.projectId}/model`);
  await page.waitForFunction(
    () => (window as any).__jobModelViewer?.model?.scene?.getItems?.()?.length === 2,
    undefined,
    { timeout: 60_000 },
  );

  // Frame the room from outside the south wall (z=600) — the exact camera
  // studio-holes.spec.ts's own "outside wall click" test uses for an
  // identically-shaped 10x6m room.
  await page.evaluate(() => {
    const bp = (window as any).__jobModelViewer;
    const c = bp.three.controls;
    c.object.position.set(500, 260, 1500);
    c.target?.set?.(500, 130, 300);
    c.update?.();
  });
  await page.waitForTimeout(300);

  await page.getByRole("button", { name: "Assign", exact: true }).click();

  // Tap "11" THEN "10" — reversed from both opening_code AND scene-load
  // order, so a correctly TAP-ordered sequence proves the pick list tracks
  // taps, not ids.
  await tapWorldPoint(page, 700, 120, 600); // mark "11"
  await tapWorldPoint(page, 300, 120, 600); // mark "10"
  await expect(page.getByText("2 picked")).toBeVisible();

  await page.getByLabel("Installer").selectOption({ index: 1 });
  const profileId = await page.getByLabel("Installer").inputValue();
  await page.getByRole("button", { name: "Assign", exact: true }).click();

  await expect.poll(() => assigns.length, { timeout: 15_000 }).toBe(2);
  expect(assigns.map((a) => a.sequence)).toEqual([1, 2]);
  expect(new Set(assigns.map((a) => a.profile))).toEqual(new Set([profileId]));

  // TAP order ("11" first) must be the assign order — not opening_code
  // order, not scene order.
  const openings = openingsFor(BLACK22.projectId);
  const idFor = (code: string) => openings.find((o) => o.opening_code === code)!.id;
  expect(assigns[0].opening).toBe(idFor("11"));
  expect(assigns[1].opening).toBe(idFor("10"));

  // Mode stays ON and the picks clear — a foreman can assign the next batch
  // without re-entering (unlike the map, which exits on every assign).
  await expect(page.getByText("0 picked")).toBeVisible();
  await expect(page.getByRole("button", { name: "Assign: on" })).toBeVisible();
});

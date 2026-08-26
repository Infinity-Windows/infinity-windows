// A net for the opening sheet (app/src/pages/install/OpeningSheet.tsx): the
// screen an installer lives in all day — start, finish, chain, redo, the
// rough-opening checklist, condition-on-arrival. Same house style as
// sessions.spec.ts: drive the real UI, mock Supabase at the network layer,
// and assert the CAPTURED RPC PAYLOAD the tap actually sends, not just that
// something happened.
//
// Block-with-preset-reason already has a test in sessions.spec.ts (the chain
// hand-off it exercises is reused here too) — it is not duplicated.
//
// Fixtures: real BLACK22 openings from support/supabaseFixtures, overridden
// per test the way sessions.spec.ts's Block test does. Each opening's
// `id=eq.` lookup is served from a small mutable map (routeOpenings below) so
// a mutation's RPC handler can patch the row the way the real server would —
// which lets "the visible state change" half of each assertion (the banner,
// the warning text, the message tone) be real rather than assumed.
import { expect, test, type Page } from "@playwright/test";
import {
  jobFixtures,
  openingsFor,
  useSupabaseFixtures,
  TEST_USER,
} from "./support/supabaseFixtures";

const BLACK22 = jobFixtures().find((j) => j.jobCode === "BLACK22")!;

/** Real fixture rows carry every OPENING_SELECT field (window_types, windows,
 * condition, confirmed…) even though the map's own OpeningRow type only
 * names a few of them — so they're read here as plain untyped records and
 * cast at the point of use, the same "cast fixture literals explicitly"
 * idiom the spec calls out. */
type Json = Record<string, unknown>;
const REAL_OPENINGS = openingsFor(BLACK22.projectId) as unknown as Json[];

function str(v: unknown): string {
  return v as string;
}

/** One real opening, overridden the way sessions.spec.ts's Block test builds
 * its fixture: `{...realRow, ...overrides}`. */
function opening(index: number, overrides: Json = {}): Json {
  return { ...REAL_OPENINGS[index], ...overrides };
}

/** A tiny (1x1) real PNG — small enough to inline, real enough for the
 * capture pipeline's canvas decode (createImageBitmap/Image) to succeed. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name: string) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
  };
}

/**
 * Serve `getOpening` for every id in `initial`, from a map a test can mutate
 * afterward (`set`) — so a mutation's RPC handler can patch the row the way
 * the real server would, and the next refetch (after `refresh()` invalidates
 * the query) shows the real consequence instead of stale fixture data.
 * Registered AFTER useSupabaseFixtures so it wins (Playwright gives priority
 * to the most-recently-added route) — same pattern as sessions.spec.ts.
 */
async function routeOpenings(page: Page, initial: Json[]) {
  const byId = new Map<string, Json>(initial.map((o) => [str(o.id), o]));
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      (url.searchParams.get("id") ?? "").startsWith("eq."),
    (route) => {
      const id = (
        new URL(route.request().url()).searchParams.get("id") ?? ""
      ).slice(3);
      const row = byId.get(id);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": row ? "0-0/1" : "*/0" },
        body: JSON.stringify(row ? [row] : []),
      });
    },
  );
  return {
    set: (id: string, patch: Json) => byId.set(id, { ...byId.get(id), ...patch }),
  };
}

/** This installer's cross-job queue (`listMyOpeningsAllJobs`) — only the
 * chain test needs it to hold anything; every other test's `next` window is
 * legitimately null, and the default fixture already answers `[]` here. */
async function routeMyOpenings(page: Page, rows: Json[]) {
  await page.route(
    (url) =>
      url.pathname.includes("/rest/v1/project_openings") &&
      (url.searchParams.get("assigned_to") ?? "").startsWith("eq."),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}`,
        },
        body: JSON.stringify(rows),
      }),
  );
}

/** Clocked in + toolbox signed. Only the Start test needs this — every other
 * test begins from a session already running (server-stamped
 * `work_started_at`, the same fixture trick sessions.spec.ts's Block test
 * uses), and once a start stamp exists the timer runs regardless of
 * eligibility (installTimer.ts) — starting fresh is the one gate that cares. */
async function routeEligible(page: Page) {
  const now = new Date().toISOString();
  await page.route(
    (url) => url.pathname.includes("/rest/v1/time_shifts"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/1" },
        body: JSON.stringify([
          {
            id: "e2e-shift",
            profile_id: TEST_USER.id,
            project_id: null,
            cost_code_id: null,
            clock_in_at: now,
            clock_out_at: null,
            break_seconds: 0,
            break_started_at: null,
            break_type: null,
            injured: false,
            time_confirmed: null,
            status: "open",
            created_at: now,
            note: null,
          },
        ]),
      }),
  );
  await page.route(
    (url) => url.pathname.includes("/rest/v1/toolbox_completions"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "content-range": "0-0/1" },
        body: JSON.stringify([
          { id: "e2e-toolbox", profile_id: TEST_USER.id, signed_at: now },
        ]),
      }),
  );
}

/** Fail geolocation immediately (PERMISSION_DENIED) so the photo-capture
 * pipeline's soft GPS lookup (captureGeoSoft, up to an 8s timeout) never
 * waits one out — headless Chromium has no UI to grant or deny the real
 * prompt, so this makes the outcome deterministic instead of relying on it. */
async function stubGeolocationDenied(page: Page) {
  await page.addInitScript(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition = (_ok, err) => {
      err?.({ code: 1, message: "denied" } as GeolocationPositionError);
    };
  });
}

test("Start: a ready opening fires start_unit_session with its own id", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);
  const o = opening(0, {
    status: "assigned",
    needs_flashing: false,
    work_started_at: null,
    confirmed: true,
  });
  await routeOpenings(page, [o]);
  await routeEligible(page);

  const starts: { opening: string; role: string }[] = [];
  await page.route("**/rest/v1/rpc/start_unit_session", async (route) => {
    const body = route.request().postDataJSON() as {
      p_opening_id: string;
      p_role: string;
    };
    starts.push({ opening: body.p_opening_id, role: body.p_role });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "sess-e2e-1", opening_id: body.p_opening_id }),
    });
  });

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);
  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles(pngFile("before.png"));
  // The label only reads "Start install →" once every gate (before photo,
  // clock eligibility) has cleared — waiting for it is waiting for the gate.
  await page.getByRole("button", { name: "Start install →" }).click();

  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0]).toEqual({ opening: str(o.id), role: "install" });
  // Visible: the sheet drops the Start gate and moves into the install stage.
  await expect(page.getByText("Installing")).toBeVisible();
});

test("Finish: submitting a capture fires finish_unit with the grade, and no chain target", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);
  const o = opening(1, {
    status: "assigned",
    needs_flashing: false,
    work_started_at: "2026-08-20T09:00:00Z",
    confirmed: true,
  });
  await routeOpenings(page, [o]);

  const finishes: Json[] = [];
  await page.route("**/rest/v1/rpc/finish_unit", async (route) => {
    finishes.push(route.request().postDataJSON() as Json);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "evt-e2e-1" }),
    });
  });

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);
  await page.getByRole("button", { name: "3. Capture" }).click();
  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles(pngFile("after.png"));
  await page.getByRole("button", { name: "4", exact: true }).click();
  await page.getByRole("button", { name: "Submit install" }).click();

  await expect.poll(() => finishes.length).toBe(1);
  expect(finishes[0]).toMatchObject({
    p_opening_id: str(o.id),
    p_next_opening_id: null,
    p_quality_grade: 4,
  });
  // Visible: the installer's post-install modal, with no chain to offer.
  await expect(page.getByText("Nice — window done.")).toBeVisible();
  await expect(
    page.getByText("That's your last assigned window — nice work."),
  ).toBeVisible();
});

test("Chain: finishing with a queued next unit hands the clock to it", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  await stubGeolocationDenied(page);
  const current = opening(2, {
    status: "assigned",
    needs_flashing: false,
    work_started_at: "2026-08-20T09:00:00Z",
    confirmed: true,
  });
  const next = opening(3, {
    status: "assigned",
    needs_flashing: false,
    work_started_at: null,
    confirmed: true,
    assigned_to: TEST_USER.id,
  });
  const openings = await routeOpenings(page, [current, next]);
  await routeMyOpenings(page, [next]);

  const finishes: Json[] = [];
  await page.route("**/rest/v1/rpc/finish_unit", async (route) => {
    const body = route.request().postDataJSON() as Json;
    finishes.push(body);
    // finish_unit's own job (spec .scratch/sessions): the chain starts the
    // NEXT unit's session server-side, in the same transaction as the finish.
    const nextId = body.p_next_opening_id;
    if (typeof nextId === "string") {
      openings.set(nextId, { work_started_at: new Date().toISOString() });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "evt-e2e-2" }),
    });
  });

  await page.goto(`/projects/${str(current.project_id)}/opening/${str(current.id)}`);
  await page.getByRole("button", { name: "3. Capture" }).click();
  await page
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles(pngFile("after.png"));
  await page.getByRole("button", { name: "5", exact: true }).click();
  await page.getByRole("button", { name: "Submit install" }).click();

  await expect.poll(() => finishes.length).toBe(1);
  expect(finishes[0].p_opening_id).toBe(str(current.id));
  expect(finishes[0].p_next_opening_id).toBe(str(next.id));

  // Visible: the modal names the chained unit, and taking it lands on its
  // sheet with the clock already running (the chain banner, not a Start tap).
  await expect(page.getByText(str(next.opening_code)).first()).toBeVisible();
  await page.getByRole("button", { name: /Next one/ }).click();
  await expect(page).toHaveURL(new RegExp(`/opening/${str(next.id)}$`));
  // Scoped past the nav bar's own role="status" sync pill, which also
  // matches a bare getByRole("status") on every page in this app.
  const banner = page.locator('.detail-card[role="status"]');
  await expect(banner).toContainText("Clock's on");
  await expect(banner).toContainText(str(next.opening_code));
});

test("Redo: filing a redo fires press_redo, and the confirmation never wears the error class", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const o = opening(4, { status: "installed", confirmed: true });
  await routeOpenings(page, [o]);

  const redos: { opening: string; reason: string }[] = [];
  await page.route("**/rest/v1/rpc/press_redo", async (route) => {
    const body = route.request().postDataJSON() as {
      p_opening_id: string;
      p_reason: string;
    };
    redos.push({ opening: body.p_opening_id, reason: body.p_reason });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "redo-e2e-1",
        opening_id: body.p_opening_id,
        pressed_by: TEST_USER.id,
        reason: body.p_reason,
        pressed_at: new Date().toISOString(),
        resolved_at: null,
      }),
    });
  });

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);
  await page.getByRole("button", { name: /Redo this window/ }).click();
  await page
    .getByPlaceholder(/failed inspection/)
    .fill("Glass fogged between panes");
  await page
    .getByRole("button", { name: "Redo — put it back in play" })
    .click();

  await expect.poll(() => redos.length).toBe(1);
  expect(redos[0]).toEqual({
    opening: str(o.id),
    reason: "Glass fogged between panes",
  });

  // Regression net for the first-word-regex bug at OpeningSheet.tsx:1271: a
  // "Redo filed" confirmation must never render in the error class, whatever
  // mechanism later decides message tone (pick 3 replaces this one — the
  // assertion is written to survive that, by naming what must NOT be true
  // rather than the class that currently makes it true).
  const confirmation = page.locator("p", { hasText: "Redo filed" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).not.toHaveClass(/error/);
});

test("Rough opening: numbers within range save with no framing issue", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const o = opening(5, {
    status: "assigned",
    confirmed: true,
    window_type_id: "wt-e2e-good",
    window_types: {
      id: "wt-e2e-good",
      type_code: "E2E",
      name: "Test unit",
      width_in: 36,
      height_in: 48,
    },
  });
  await routeOpenings(page, [o]);

  const saves: Json[] = [];
  await page.route(
    "**/rest/v1/rpc/set_opening_rough_opening",
    async (route) => {
      saves.push(route.request().postDataJSON() as Json);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...o, ro_width_in: 36.25, ro_height_in: 48.25 }),
      });
    },
  );
  const issues: Json[] = [];
  await page.route("**/rest/v1/rpc/create_issue", async (route) => {
    issues.push(route.request().postDataJSON() as Json);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    });
  });

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);

  await page
    .getByRole("group", { name: "Square?" })
    .getByRole("button", { name: "Good ✓" })
    .click();
  const diagInputs = page
    .locator(".ro-check")
    .filter({ hasText: "Square?" })
    .locator('input[type="number"]');
  await diagInputs.nth(0).fill("50");
  await diagInputs.nth(1).fill("50.1");

  await page
    .getByRole("group", { name: "Width?" })
    .getByRole("button", { name: "Good ✓" })
    .click();
  await page
    .locator(".ro-check")
    .filter({ hasText: "Width?" })
    .locator('input[type="number"]')
    .nth(0)
    .fill("36.25");

  await page
    .getByRole("group", { name: "Height?" })
    .getByRole("button", { name: "Good ✓" })
    .click();
  const heightInputs = page
    .locator(".ro-check")
    .filter({ hasText: "Height?" })
    .locator('input[type="number"]');
  await heightInputs.nth(0).fill("48.25");
  await heightInputs.nth(1).fill("48.3");

  await page
    .getByRole("button", { name: "Save rough opening", exact: true })
    .click();

  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({
    p_opening_id: str(o.id),
    p_width_in: 36.25,
    p_height_in: 48.25,
  });
  expect((saves[0].p_check as Json).judgments).toEqual({
    square: "good",
    width: "good",
    height: "good",
  });
  expect((saves[0].p_check as Json).diagonals).toEqual(["50", "50.1"]);

  await expect(page.getByText("Rough opening saved.", { exact: true })).toBeVisible();
  expect(issues).toHaveLength(0);
});

test("Rough opening: a too-tight measurement saves AND files a framing issue", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const o = opening(6, {
    status: "assigned",
    confirmed: true,
    window_type_id: "wt-e2e-bad",
    window_types: {
      id: "wt-e2e-bad",
      type_code: "E2E2",
      name: "Test unit",
      width_in: 36,
      height_in: 48,
    },
  });
  await routeOpenings(page, [o]);

  const saves: Json[] = [];
  await page.route(
    "**/rest/v1/rpc/set_opening_rough_opening",
    async (route) => {
      saves.push(route.request().postDataJSON() as Json);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...o, ro_width_in: 36.05, ro_height_in: 48.25 }),
      });
    },
  );
  const issues: Json[] = [];
  await page.route("**/rest/v1/rpc/create_issue", async (route) => {
    issues.push(route.request().postDataJSON() as Json);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    });
  });

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);

  // The tape measure outranks the thumb (roCheck.ts): tapping Good on a
  // width that is only 0.05" over the unit — under the 1/8" minimum to
  // shim — must still file as a failure.
  await page
    .getByRole("group", { name: "Width?" })
    .getByRole("button", { name: "Good ✓" })
    .click();
  await page
    .locator(".ro-check")
    .filter({ hasText: "Width?" })
    .locator('input[type="number"]')
    .nth(0)
    .fill("36.05");

  await page
    .getByRole("group", { name: "Height?" })
    .getByRole("button", { name: "Good ✓" })
    .click();
  const heightInputs = page
    .locator(".ro-check")
    .filter({ hasText: "Height?" })
    .locator('input[type="number"]');
  await heightInputs.nth(0).fill("48.25");
  await heightInputs.nth(1).fill("48.3");

  await page
    .getByRole("button", { name: "Save — files a framing issue for this window" })
    .click();

  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({
    p_opening_id: str(o.id),
    p_width_in: 36.05,
    p_height_in: 48.25,
  });
  expect((saves[0].p_check as Json).judgments).toEqual({
    square: null,
    width: "good",
    height: "good",
  });

  await expect.poll(() => issues.length).toBe(1);
  expect(issues[0]).toMatchObject({
    p_project: str(o.project_id),
    p_opening: str(o.id),
    p_kind: "framing",
  });
  expect(String(issues[0].p_note)).toContain("Width");

  await expect(
    page.getByText("Rough opening saved — framing issue filed for this unit."),
  ).toBeVisible();
});

test("Condition: marking a unit damaged fires set_opening_condition with the note", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "installer" });
  const o = opening(7, {
    status: "assigned",
    confirmed: true,
    assigned_window_id: "unit-e2e-1",
    windows: {
      id: "unit-e2e-1",
      window_id: "W-0001",
      status: "on_site",
      window_type_id: null,
    },
    condition: "unknown",
  });
  const openings = await routeOpenings(page, [o]);

  const conditions: Json[] = [];
  await page.route("**/rest/v1/rpc/set_opening_condition", async (route) => {
    const body = route.request().postDataJSON() as Json;
    conditions.push(body);
    openings.set(str(o.id), {
      condition: body.p_condition,
      condition_note: body.p_note,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...o,
        condition: body.p_condition,
        condition_note: body.p_note,
      }),
    });
  });

  await page.goto(`/projects/${str(o.project_id)}/opening/${str(o.id)}`);
  await page
    .getByPlaceholder("Damage note (optional)")
    .fill("Scratched frame, top rail");
  await page.getByRole("button", { name: "Damaged", exact: true }).click();

  await expect.poll(() => conditions.length).toBe(1);
  expect(conditions[0]).toMatchObject({
    p_opening_id: str(o.id),
    p_condition: "damaged",
    p_note: "Scratched frame, top rail",
  });

  // Visible: the arrival-condition warning and the honest way out both show
  // up once the refetch reflects the condition the RPC just recorded.
  await expect(page.getByText("Unit flagged damaged.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Skip for now — go to my work" }),
  ).toBeVisible();
});

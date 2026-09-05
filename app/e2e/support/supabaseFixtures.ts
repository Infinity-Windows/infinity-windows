// Replay the map's Supabase traffic from committed fixtures.
//
// The app needs a Supabase sign-in and a device PIN before it will render
// anything, and neither belongs in a screenshot test: a test that needs Taylor's
// password is a test nobody can run. So the browser is handed a session it
// believes in, and every request the map makes is answered from JSON captured
// out of production (see ../capture-fixtures.mjs).
//
// Three consequences worth knowing before trusting a screenshot from this:
//   - The pin geometry, statuses, marks, and plansets are REAL production rows.
//   - The signed-in user is a made-up installer, not a real crew member.
//   - `my_pin_status` answers false, i.e. "this device has no PIN", which is a
//     normal state — it is the only way past a lock whose secret is server-side.
//
// Anything the router does not recognise answers with an empty list and is
// logged, so a screen that silently lost its data shows up as a warning rather
// than as a blank picture that passed.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../fixtures");
const REPO_ROOT = resolve(HERE, "../../..");
/** Where the storage bucket's real objects were backed up to. */
const STORAGE_BACKUP = join(
  REPO_ROOT,
  "docs/backups/czprjcskmzzagdztqonm-storage",
);

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

export interface JobFixture {
  jobCode: string;
  projectId: string;
  /** Marks per page, from the fixture itself — the test asserts against these. */
  marksByPage: Map<number, number>;
  /**
   * Openings with no pin. They are auto-placed around the perimeter on every
   * page, so they are added to whichever page's count the map is showing.
   */
  unpinned: number;
}

interface ProjectRow {
  id: string;
  job_code: string;
}

export interface OpeningRow {
  id: string;
  project_id: string;
  opening_code: string;
  page_number: number | null;
  pin_x: number | null;
  pin_y: number | null;
}

interface PlansetRow {
  id: string;
  project_id: string;
  storage_path: string;
  converted_pdf_path: string | null;
}

const JOB_CODES = ["BLACK22", "PECAN14", "OAKRIDGE"] as const;

const projects = fixture<ProjectRow[]>("projects.json");
const plansets = fixture<PlansetRow[]>("plansets.json");
const profiles = fixture<Record<string, unknown>[]>("profiles.json");
const windowTypes = fixture<unknown[]>("window_types.json");
const markSpecs = fixture<Record<string, unknown>[]>("mark_specs.json");
const elevationViews = fixture<Record<string, unknown>[]>("elevation_views.json");
const planOutlines = fixture<unknown[]>("plan_outlines.json");

const openingsByProject = new Map<string, OpeningRow[]>();
for (const code of JOB_CODES) {
  const rows = fixture<OpeningRow[]>(`openings.${code}.json`);
  if (rows.length > 0) openingsByProject.set(rows[0].project_id, rows);
}

/**
 * The signed-in user. Deliberately not a real crew member: an installer is the
 * role that reads this screen on a ladder, and it is the role with the fewest
 * extra powers, so nothing on the map is a lead-only affordance.
 */
export const TEST_USER = {
  id: "00000000-0000-4000-8000-0000000000e2",
  aud: "authenticated",
  role: "authenticated",
  email: "e2e-fixture@infinity.test",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  phone: "",
  confirmed_at: "2026-01-01T00:00:00Z",
  last_sign_in_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  identities: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  is_anonymous: false,
};

const TEST_PROFILE = {
  id: TEST_USER.id,
  display_name: "E2E Fixture",
  skill_level: 3,
  role: "installer",
  active: true,
  // Wave Z: the two money grants an owner hands out. False by default, which is
  // what every account starts as and what every spec should be measuring
  // against unless it says otherwise.
  can_see_costs: false,
  can_see_pay: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

export interface FixtureOptions {
  /**
   * Role the fixture user signs in as. Defaults to installer (fewest powers —
   * see TEST_USER above); a spec for a gated screen (Model Studio is
   * supervisor+) names the weakest role that can reach it.
   */
  role?: "installer" | "foreman" | "supervisor" | "owner";
  /**
   * Wave Z: sign in as somebody the owner granted "Sees costs" / "Sees pay
   * rates". These are grants on a PERSON, not a rank, so a spec proving the
   * money doors has to be able to set them independently of `role`.
   */
  canSeeCosts?: boolean;
  canSeePay?: boolean;
  /**
   * The signed-in person's reading language. `profiles.language` is what the
   * app actually resolves from (LanguageProvider: the profile wins once
   * loaded, the device cache only carries the first paint), so a spec proving
   * a screen speaks Spanish has to set it HERE — seeding the localStorage
   * cache alone is overruled the moment the profile query returns.
   */
  language?: "en" | "es";
}

/** Every first-run micro-tip, pre-dismissed (see lib/featureTips). */
const DISMISSED_TIPS = [
  "home",
  "home_installer",
  "my_work",
  "projects",
  "photos",
  "chat",
  "schedule",
  "travel",
];

/** Expires in 2035, so nothing ever tries to refresh mid-test. */
const SESSION = {
  access_token: "e2e-fixture-access-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 2_066_000_000,
  refresh_token: "e2e-fixture-refresh-token",
  user: TEST_USER,
};

export function jobFixtures(): JobFixture[] {
  return JOB_CODES.map((jobCode) => {
    const project = projects.find((p) => p.job_code === jobCode);
    if (!project) throw new Error(`No fixture project for ${jobCode}`);
    const marksByPage = new Map<number, number>();
    let unpinned = 0;
    for (const o of openingsByProject.get(project.id) ?? []) {
      if (o.pin_x === null || o.pin_y === null || o.page_number === null) {
        unpinned++;
        continue;
      }
      marksByPage.set(o.page_number, (marksByPage.get(o.page_number) ?? 0) + 1);
    }
    return { jobCode, projectId: project.id, marksByPage, unpinned };
  });
}

/**
 * The job's real openings, with the coordinates the extraction gave them.
 *
 * Exported so a test can check that the dot for a given opening is drawn at the
 * fraction of the sheet the database says, rather than somewhere near it.
 */
export function openingsFor(projectId: string): OpeningRow[] {
  return openingsByProject.get(projectId) ?? [];
}

/** The building planset the map picks: newest `kind = building` PDF. */
export function buildingPlansetFor(projectId: string): PlansetRow {
  const row = plansets.find(
    (ps) =>
      ps.project_id === projectId &&
      ((ps as { kind?: string }).kind ?? "building") === "building",
  );
  if (!row) throw new Error(`No building planset fixture for ${projectId}`);
  return row;
}

/**
 * The real planset PDF on disk, from the storage backup in `docs/backups`.
 *
 * Deliberately NOT stubbed with a blank PDF: which pages are floor plans, and
 * therefore which page the map opens on, is decided by reading this file. A
 * placeholder would open PECAN14 on page 1 — a page with no marks on it — and
 * the screenshot would be an empty building that still passed.
 */
export function plansetPdfPath(planset: PlansetRow): string | null {
  const path = planset.converted_pdf_path ?? planset.storage_path;
  const file = join(STORAGE_BACKUP, "plansets", path);
  return existsSync(file) ? file : null;
}

function jsonRoute(route: Route, body: unknown, rows = 0) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "content-range": `0-${Math.max(0, rows - 1)}/${rows}` },
    body: JSON.stringify(body),
  });
}

/** `?project_id=eq.<uuid>` → "<uuid>". */
function eqParam(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  if (!raw) return null;
  return raw.startsWith("eq.") ? raw.slice(3) : raw;
}

function wantsSingleObject(route: Route): boolean {
  const accept = route.request().headers()["accept"] ?? "";
  return accept.includes("pgrst.object");
}

function byProject<T extends { project_id?: string }>(
  rows: T[],
  url: URL,
): T[] {
  const projectId = eqParam(url, "project_id");
  return projectId ? rows.filter((r) => r.project_id === projectId) : rows;
}

/**
 * Install the fixture router on a page. Call before `page.goto`.
 *
 * `unmatched` collects every REST table and RPC the router had to guess at, so
 * a test can fail loudly when the app starts asking for something new.
 */
export async function useSupabaseFixtures(
  page: Page,
  opts: FixtureOptions = {},
): Promise<{
  unmatched: string[];
  missingStorage: string[];
}> {
  const unmatched: string[] = [];
  const missingStorage: string[] = [];
  const profile = {
    ...TEST_PROFILE,
    role: opts.role ?? TEST_PROFILE.role,
    can_see_costs: opts.canSeeCosts ?? false,
    can_see_pay: opts.canSeePay ?? false,
    language: opts.language ?? "en",
  };

  // A session in localStorage, under whatever key this build's Supabase URL
  // produces (`sb-<ref>-auth-token`), so the app boots signed in. Also settles
  // the first-run overlays — the permissions wizard is a modal that would sit
  // squarely on top of the drawing, and a screenshot of a modal proves nothing
  // about the map.
  await page.addInitScript(
    ({ session, tipKeys, lang }) => {
      const raw = JSON.stringify(session);
      const proto = Object.getPrototypeOf(window.localStorage);
      const original = proto.getItem;
      proto.getItem = function patched(this: Storage, key: string) {
        if (this === window.localStorage && /^sb-.+-auth-token$/.test(key)) {
          return raw;
        }
        return original.call(this, key);
      };
      window.localStorage.setItem("infinity-perm-wizard-choice", "completed");
      window.localStorage.setItem(
        "infinity:dismissed-tips",
        JSON.stringify(tipKeys),
      );
      // Same reasoning as the wizard above: the Studio's first-open tour
      // (Studio 100x #44) is a modal-backdrop overlay that would sit on
      // top of the drawing on every fixture's first Studio visit.
      window.localStorage.setItem("studio-tour-seen", "1");
      // And the first-login language picker (i18n slice 0): a full-screen
      // choice shown until a language is picked on this device. Seeding the
      // cache marks the choice as made, so it never overlays a fixture.
      window.localStorage.setItem("infinity.language", lang);
    },
    { session: SESSION, tipKeys: DISMISSED_TIPS, lang: opts.language ?? "en" },
  );

  await page.route("**/auth/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/user")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TEST_USER),
      });
    }
    if (path.endsWith("/token")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION),
      });
    }
    return route.fulfill({ status: 204, body: "" });
  });

  await page.route("**/rest/v1/**", (route) => {
    const url = new URL(route.request().url());
    const table = url.pathname.split("/rest/v1/")[1]?.split("?")[0] ?? "";

    if (table.startsWith("rpc/")) {
      const fn = table.slice(4);
      // No device PIN on this fixture device — the only honest way past a lock
      // whose secret is verified server-side.
      if (fn === "my_pin_status") return jsonRoute(route, false);
      // Wave D: echoes back whatever ids it was asked about — "nothing is
      // trashed" is the correct default for every fixture spec that isn't
      // specifically testing the trash flow (those override this route
      // themselves, see project-delete.spec.ts). Answering `null` here
      // (the generic unmatched-RPC fallback below) would make every list
      // this powers — an installer's cross-job openings, live summons, the
      // crew schedule board — silently filter down to empty for EVERY
      // fixture spec that reads them, not just the ones about trash.
      if (fn === "live_project_ids") {
        const body = route.request().postDataJSON() as { p_ids?: string[] } | null;
        return jsonRoute(route, body?.p_ids ?? []);
      }
      unmatched.push(`rpc/${fn}`);
      return jsonRoute(route, null);
    }

    switch (table) {
      case "projects":
        return jsonRoute(route, projects, projects.length);
      case "project_openings": {
        const projectId = eqParam(url, "project_id");
        const rows = projectId ? openingsByProject.get(projectId) ?? [] : [];
        return jsonRoute(route, rows, rows.length);
      }
      case "project_plansets": {
        const rows = byProject(plansets, url);
        return jsonRoute(route, rows, rows.length);
      }
      case "project_plan_outlines":
        // Empty in production for all three jobs: nobody has traced a
        // footprint, which is exactly the case the drawing has to handle.
        return jsonRoute(route, planOutlines, 0);
      case "project_mark_specs": {
        const rows = byProject(markSpecs, url);
        return jsonRoute(route, rows, rows.length);
      }
      case "project_mark_elevation_views": {
        const rows = byProject(elevationViews, url);
        return jsonRoute(route, rows, rows.length);
      }
      case "window_types":
        return jsonRoute(route, windowTypes, windowTypes.length);
      case "profiles": {
        const all = [...profiles, profile];
        const id = eqParam(url, "id");
        const rows = id ? all.filter((p) => p.id === id) : all;
        if (wantsSingleObject(route)) {
          return jsonRoute(route, rows[0] ?? null, rows.length ? 1 : 0);
        }
        return jsonRoute(route, rows, rows.length);
      }
      default:
        unmatched.push(table);
        return jsonRoute(route, wantsSingleObject(route) ? null : [], 0);
    }
  });

  await page.route("**/storage/v1/**", (route) => {
    const url = new URL(route.request().url());
    const objectPath = decodeURIComponent(
      url.pathname.split("/storage/v1/object/")[1] ?? "",
    ).replace(/^(authenticated|public)\//, "");
    const [, ...rest] = objectPath.split("/"); // drop the bucket name
    const file = join(STORAGE_BACKUP, "plansets", rest.join("/"));
    if (existsSync(file)) {
      return route.fulfill({
        status: 200,
        contentType: "application/pdf",
        body: readFileSync(file),
      });
    }
    missingStorage.push(objectPath);
    return route.fulfill({ status: 404, body: "not found" });
  });

  // Edge functions are AI helpers the map never needs to draw itself.
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 501, contentType: "application/json", body: "{}" }),
  );

  return { unmatched, missingStorage };
}

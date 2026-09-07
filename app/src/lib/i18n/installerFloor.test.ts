// The installer-floor bilingual smoke test (installer-spanish-first-fourteen,
// 2026-09-06).
//
// Most of the crew reads Spanish more comfortably than English (CONTEXT.md).
// This test is the guard rail: for every route in nav.ts reachable at the
// installer floor (minRole: "installer"), it resolves the page file App.tsx
// actually mounts for that route and fails if neither that file NOR — for a
// thin wrapper — the component it renders ever calls `useT(`. It is a floor,
// not a completeness audit: one `useT(` call anywhere in the file is enough
// to pass, same as a real translation sweep leaves most files at first.
//
// ROUTE_FILES below is a hand-maintained mirror of the routing in App.tsx and
// the role-conditional renders in RoleLanding/ClockRoute there — there is no
// AST walk of the router, so a route whose destination component changes
// needs this map updated by hand. Comments on each entry say why it points
// where it does.
//
// ALLOW_LIST names every file this test currently accepts as English-only.
// It may only SHRINK: the second describe block below asserts every listed
// file still has zero `useT(` calls, so the day one of them gains real
// translation work, this test fails and forces the list to be trimmed —
// it can never silently go stale in the other direction.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, type RoutePath } from "../nav";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** app/src — this file lives at app/src/lib/i18n/. */
const SRC_ROOT = path.resolve(__dirname, "../../");

function hasUseT(relPath: string): boolean {
  const full = path.join(SRC_ROOT, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(
      `installerFloor.test.ts: "${relPath}" no longer exists — update ROUTE_FILES/ALLOW_LIST (the file this test was checking moved or was renamed).`,
    );
  }
  return fs.readFileSync(full, "utf8").includes("useT(");
}

/**
 * Every installer-floor nav route → the candidate file(s) that render it.
 * The check passes if ANY listed candidate contains `useT(`. Most entries
 * have one candidate; a thin wrapper (Scan) or a role-conditional landing
 * (home) lists the real destination instead of (or alongside) the route's
 * own file.
 */
const ROUTE_FILES: Partial<Record<string, string[]>> = {
  // RoleLanding renders MyWork/Home/Heartbeat by rank; an installer (rank 0)
  // always lands on MyWork — that is the file this route means for THIS
  // floor, even though "/" is also how foreman+ reach Home/Heartbeat.
  home: ["pages/MyWork.tsx"],
  // ClockRoute (App.tsx) has no text of its own — it opens the shared clock
  // sheet mounted in Layout.tsx and redirects to "/".
  clock: ["components/Layout.tsx"],
  learn: ["pages/Education.tsx"],
  points: ["pages/Points.tsx"],
  safety: ["pages/Safety.tsx"],
  // Scan.tsx is a thin wrapper (App.tsx comment) around ScanSheet — the
  // audit-item-C merge (2026-09-06) lives entirely in ScanSheet.tsx.
  scan: ["pages/Scan.tsx", "components/warehouse/ScanSheet.tsx"],
  "storage-arrive": ["pages/storage/ArrivePackages.tsx"],
  "storage-tag": ["pages/storage/TagPackages.tsx"],
  "storage-out": ["pages/storage/CheckoutPackages.tsx"],
  // NAV's "/warehouse/send" is a menu entry; the real route is
  // "/warehouse/send/:projectId" → SendToSite.
  "warehouse-send": ["pages/storage/SendToSite.tsx"],
  "warehouse-history": ["pages/storage/WarehouseHistory.tsx"],
  // Likewise "/warehouse/3d" → "/warehouse/3d/:id" → ContainerViewer.
  "warehouse-3d": ["pages/storage/ContainerViewer.tsx"],
  "job-model": ["pages/install/JobModelViewer.tsx"],
  takeoffs: ["pages/Takeoffs.tsx"],
  warehouse: ["pages/Warehouse.tsx"],
  projects: ["pages/Projects.tsx"],
  ask: ["pages/AskInfinity.tsx"],
  notifications: ["pages/Notifications.tsx"],
  stuck: ["pages/StuckWrites.tsx"],
  diagnostics: ["pages/Diagnostics.tsx"],
  suggestions: ["pages/Suggestions.tsx"],
  // "/search" is a bare `<Navigate to="/warehouse" replace />` in App.tsx —
  // it renders nothing of its own, so the route means Warehouse.tsx.
  search: ["pages/Warehouse.tsx"],
  review: ["pages/MemoReview.tsx"],
  "my-schedule": ["pages/MySchedule.tsx"],
  travel: ["pages/Travel.tsx"],
  timecard: ["pages/Timecard.tsx", "components/timecard/TimecardPanel.tsx"],
  // "/receive" → `<Navigate to="/storage/log-delivery" replace />`.
  receive: ["pages/storage/LogDelivery.tsx"],
  // "/storage" → `<Navigate to="/warehouse" replace />` (ticket 18 merge).
  storage: ["pages/Warehouse.tsx"],
  supplies: ["pages/Supplies.tsx"],
  photos: ["pages/Photos.tsx"],
  "toolbox-history": ["pages/ToolboxHistory.tsx"],
};

/**
 * Files this sweep (installer-spanish-first-fourteen) measured as still
 * English-only, and the task list explicitly allowed leaving that way:
 * Warehouse.tsx and the warehouse/storage detail screens it fans out to
 * (ArrivePackages, TagPackages, CheckoutPackages, SendToSite,
 * WarehouseHistory, ContainerViewer, LogDelivery), AskInfinity.tsx, and
 * JobModelViewer.tsx. Every other installer-floor screen measured with at
 * least one `useT(` call already — Photos.tsx included, so it did NOT need
 * listing here (a earlier draft of this task guessed it might).
 *
 * Shrink this list as each file gets translated; never grow it without also
 * widening the task that translates it.
 */
const ALLOW_LIST: string[] = [
  "pages/Warehouse.tsx",
  "pages/AskInfinity.tsx",
  "pages/install/JobModelViewer.tsx",
  "pages/storage/ArrivePackages.tsx",
  "pages/storage/TagPackages.tsx",
  "pages/storage/CheckoutPackages.tsx",
  "pages/storage/SendToSite.tsx",
  "pages/storage/WarehouseHistory.tsx",
  "pages/storage/ContainerViewer.tsx",
  "pages/storage/LogDelivery.tsx",
];

const INSTALLER_ROUTES = NAV.filter((d) => d.minRole === "installer");

describe("installer-floor screens speak Spanish (at least a little)", () => {
  it.each(INSTALLER_ROUTES)(
    "$id ($to) resolves to a file that calls useT(, or is on the allow-list",
    (dest: { id: string; to: RoutePath }) => {
      const candidates = ROUTE_FILES[dest.id];
      expect(
        candidates,
        `No ROUTE_FILES entry for nav id "${dest.id}" (${dest.to}). ` +
          `Add one — see the file comment for how thin wrappers and redirects are handled.`,
      ).toBeDefined();

      const translated = candidates!.some((f) => hasUseT(f));
      const allAllowListed = candidates!.every((f) => ALLOW_LIST.includes(f));

      if (!translated && !allAllowListed) {
        throw new Error(
          `"${dest.id}" (${dest.to}) resolves to ${candidates!.join(" / ")}, ` +
            `none of which call useT( and none of which are on ALLOW_LIST. ` +
            `Either translate it or add it to ALLOW_LIST with a reason.`,
        );
      }
      expect(translated || allAllowListed).toBe(true);
    },
  );

  // Every nav id actually has a ROUTE_FILES entry — catches a route added to
  // NAV without this map ever being told about it, rather than the loop
  // above silently skipping it.
  it("every installer-floor nav id is mapped in ROUTE_FILES", () => {
    const unmapped = INSTALLER_ROUTES.map((d) => d.id).filter((id) => !ROUTE_FILES[id]);
    expect(unmapped).toEqual([]);
  });
});

describe("the allow-list may only shrink", () => {
  it.each(ALLOW_LIST)("%s is still English-only (trim it from ALLOW_LIST once translated)", (relPath) => {
    expect(
      hasUseT(relPath),
      `${relPath} now calls useT( — remove it from ALLOW_LIST in installerFloor.test.ts.`,
    ).toBe(false);
  });
});

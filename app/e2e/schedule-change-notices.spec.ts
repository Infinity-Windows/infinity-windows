import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures as installSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

// A mutable server fixture, not a local-storage-only dismissal: every reload
// re-reads the same person's saved dismissals and the current published row.
async function noticeFixture(page: Page, language: "en" | "es" = "en") {
  await installSupabaseFixtures(page, { role: "installer", language });
  await hideWrongProjectBanner(page);
  const day = new Date().toISOString().slice(0, 10);
  const project = { id: "notice-fixture-project", job_code: "NOTICE-ONE", name: "North building entrance with a long job name for phone wrapping", status: "active", purged_at: null };
  const assignment = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab01", project_id: project.id, kind: "install", status: "published",
    start_date: day, end_date: day, start_time: "07:00:00" as string | null, end_time: "12:00:00" as string | null,
    notice_revision: 0, color: null as string | null, note: null,
    published_at: `${day}T12:00:00Z`, created_at: `${day}T12:00:00Z`, updated_at: `${day}T12:00:00Z`,
    projects: project,
    schedule_assignment_members: [{ profile_id: TEST_USER.id, role: "installer", profiles: { display_name: "Fixture installer" } }],
  };
  const dismissed = new Set<string>();
  let foreignRow = false;
  await page.route("**/rest/v1/projects**", r => json(r, [project]));
  await page.route("**/rest/v1/schedule_assignment_members**", r => json(r, [{ assignment_id: assignment.id }]));
  await page.route("**/rest/v1/schedule_assignments**", r => {
    const params = new URL(r.request().url()).searchParams;
    const rows = assignment.status === "published" ? [assignment] : [];
    if (foreignRow) rows.push({ ...assignment, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab02", start_time: "22:00:00", end_time: "23:00:00", notice_revision: 9, schedule_assignment_members: [{ profile_id: "other-person", role: "installer", profiles: { display_name: "Other person" } }] });
    return json(r, rows.filter(a => !params.get("id") || params.get("id")!.includes(a.id)));
  });
  await page.route("**/rest/v1/notification_dismissals**", r => {
    if (r.request().method() === "POST") {
      const body = r.request().postDataJSON() as { key: string; profile_id: string }[];
      for (const row of body) {
        expect(row.profile_id).toBe(TEST_USER.id);
        dismissed.add(row.key);
      }
    }
    return json(r, [...dismissed].map(key => ({ key })));
  });
  const load = async () => {
    await page.goto("/notifications");
    await page.waitForLoadState("networkidle");
  };
  return { assignment, dismissed, load, includeForeign: () => { foreignRow = true; } };
}

const notice = (page: Page) => page.locator('.notif-row[href$="/my-schedule"]');
const clearNotice = async (page: Page) => {
  await notice(page).locator(".notif-clear").click();
  await expect(notice(page)).toHaveCount(0);
};

test("cleared schedule returns for changed hours on the same assignment, survives dismissal, and returns for a change back", async ({ page }) => {
  const f = await noticeFixture(page);
  await f.load();
  await expect(notice(page)).toHaveCount(1);
  await clearNotice(page);
  expect(f.dismissed.size).toBe(1);
  await f.load();
  await expect(notice(page)).toHaveCount(0);

  f.assignment.start_time = "09:00:00";
  f.assignment.notice_revision = 1;
  await f.load();
  await expect(notice(page)).toHaveCount(1, { timeout: 3_000 });
  await expect(notice(page)).toContainText("North building entrance");
  await expect(notice(page)).toContainText("9:00 AM");
  await expect(notice(page)).toContainText("12:00 PM");
  await clearNotice(page);
  expect(f.dismissed.size).toBe(2);
  await f.load();
  await expect(notice(page)).toHaveCount(0);

  f.assignment.start_time = "07:00:00";
  f.assignment.notice_revision = 2;
  await f.load();
  await expect(notice(page)).toHaveCount(1);
  await expect(notice(page)).toContainText("7:00 AM");
  await page.screenshot({ path: test.info().outputPath("schedule-notice-390-en.png"), fullPage: true });
});

test("cosmetic edits and other people's timing remain quiet after clearing", async ({ page }) => {
  const f = await noticeFixture(page);
  await f.load();
  await clearNotice(page);
  f.assignment.color = "#abcdef";
  f.assignment.updated_at = `${f.assignment.start_date}T15:00:00Z`;
  f.includeForeign();
  await f.load();
  await expect(notice(page)).toHaveCount(0);
  expect(f.dismissed.size).toBe(1);
  f.assignment.status = "draft";
  await f.load();
  await expect(notice(page)).toHaveCount(0);
});

for (const variant of [{ width: 375, language: "es" as const }, { width: 1280, language: "en" as const }]) {
  test(`schedule details wrap at ${variant.width}px in ${variant.language}, including seconds and unset hours`, async ({ page }) => {
    await page.setViewportSize({ width: variant.width, height: 844 });
    const f = await noticeFixture(page, variant.language);
    f.assignment.notice_revision = 1;
    f.assignment.start_time = "09:00:30";
    f.assignment.end_time = "12:00:45";
    await f.load();
    await expect(notice(page)).toContainText("North building entrance");
    await expect(notice(page)).toContainText(variant.language === "es" ? "09:00:30" : "9:00:30 AM");
    await expect(notice(page)).toContainText(variant.language === "es" ? "12:00:45" : "12:00:45 PM");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`schedule-notice-${variant.width}-${variant.language}.png`), fullPage: true });
    f.assignment.start_time = null;
    f.assignment.end_time = null;
    f.assignment.notice_revision = 2;
    await f.load();
    await expect(notice(page)).toContainText(variant.language === "es" ? "Sin hora de inicio/fin" : "Start/end not set");
    await expect(notice(page)).not.toContainText("09:00:30");
    f.assignment.start_time = "25:99";
    f.assignment.notice_revision = 3;
    await f.load();
    await expect(notice(page)).toContainText(variant.language === "es" ? "revisa la hora" : "check time");
  });
}

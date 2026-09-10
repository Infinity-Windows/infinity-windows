import { test, expect, type Page } from "@playwright/test";
import { useSupabaseFixtures as configureSupabaseFixtures } from "./support/supabaseFixtures";
import { json, hideWrongProjectBanner } from "./support/specHelpers";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function initial() {
  return {
    id: ID,
    name: "Mesa Heights",
    contractor: "STG Windows",
    contact_name: "Jamie",
    contact_email: "",
    contact_phone: "",
    address: "123 Mesa Way",
    city: "St. George",
    state: "UT",
    kind: "installation",
    stage: "drafting",
    scope: "Install phase A",
    notes: "",
    project_id: null,
    start_precision: "month",
    target_start: "2026-10-01",
    target_end: null,
    confirmed_start: null,
    confirmation_note: "",
    follow_up_on: "2026-09-01",
    version: 1,
    created_at: "2026-09-01T12:00:00Z",
    updated_at: "2026-09-01T12:00:00Z",
  };
}
async function setup(
  page: Page,
  role: "supervisor" | "installer" = "supervisor",
) {
  await configureSupabaseFixtures(page, { role });
  await hideWrongProjectBanner(page);
  let job: Record<string, unknown> = initial();
  const bids: Record<string, unknown>[] = [];
  const rates: Record<string, unknown>[] = [];
  const writes: Record<string, unknown>[] = [];
  await page.route("**/rest/v1/proposal_jobs**", (r) => json(r, [job]));
  await page.route("**/rest/v1/proposal_bids**", (r) => json(r, bids));
  await page.route("**/rest/v1/proposal_rates**", (r) => json(r, rates));
  await page.route("**/rest/v1/proposal_documents**", (r) => json(r, []));
  await page.route("**/rest/v1/proposal_activity**", (r) => json(r, []));
  await page.route("**/rest/v1/rpc/proposal_write", (r) => {
    const { p_action, p_data } = r.request().postDataJSON();
    writes.push({ action: p_action, ...p_data });
    if (p_action === "create") {
      job = {
        ...initial(),
        ...p_data,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      };
      return json(r, job);
    }
    if (p_action === "edit" || p_action === "stage")
      job = { ...job, ...p_data, version: Number(job.version) + 1 };
    if (p_action === "bid") {
      bids.unshift({
        id: "bid" + bids.length,
        job_id: ID,
        revision: bids.length + 1,
        accepted_at: null,
        ...p_data,
      });
      job = { ...job, version: Number(job.version) + 1 };
    }
    if (p_action === "rate")
      rates.unshift({
        id: "rate",
        created_at: "2026-09-09T12:00:00Z",
        ...p_data,
        amount: p_data.amount === "" ? null : Number(p_data.amount),
      });
    return json(r, { job, record: null });
  });
  return { writes };
}
test("phone saves job timing and bid revision without treating a month as confirmed", async ({
  page,
}) => {
  const f = await setup(page);
  await page.goto("/workflow");
  await hideWrongProjectBanner(page);
  await expect(
    page.getByRole("heading", { name: "Workflow", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Mesa Heights", exact: true }).click();
  await page.getByLabel("City", { exact: true }).fill("Las Vegas");
  await page.getByLabel("State", { exact: true }).selectOption("NV");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  expect(f.writes[0]).toMatchObject({
    action: "edit",
    state: "NV",
    start_precision: "month",
    target_start: "2026-10-01",
    confirmed_start: null,
    version: 1,
  });
  await page.getByRole("button", { name: "Bids", exact: true }).click();
  await page.getByRole("button", { name: "Add bid", exact: true }).click();
  await page.getByLabel("Proposal number").fill("P-101");
  await page.getByLabel("Bid amount", { exact: true }).fill("4200");
  await page.getByLabel("Submitted date").fill("2026-09-01");
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(
    page.getByRole("heading", { name: "P-101 Revision 1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Record acceptance" }).click();
  await expect(page.getByLabel("Signed proposal")).toBeVisible();
  await page.getByRole("button", { name: "All jobs", exact: true }).click();
  await expect(page.getByText("Out-of-state", { exact: true })).toBeVisible();
  await expect(page.getByText("October 2026 · tentative")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../../work/workflow-phone.png",
    fullPage: true,
  });
});
test("desktop moves job, offers undo, and keeps an unset rate blank", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const f = await setup(page);
  await page.goto("/workflow");
  await hideWrongProjectBanner(page);
  await page.getByLabel("Move Mesa Heights").selectOption("intake");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Move Mesa Heights")).toHaveValue("drafting");
  expect(f.writes.slice(0, 2).map((w) => w.version)).toEqual([1, 2]);
  await page.getByRole("button", { name: "Rates", exact: true }).click();
  await page.getByRole("button", { name: "Add rate" }).click();
  await page.getByLabel("Rate name").fill("Minimum visit");
  await page.getByRole("button", { name: "Save rate" }).click();
  await expect(page.getByText("Not set", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../../work/workflow-desktop.png",
    fullPage: true,
  });
});
test("installer cannot open the internal Workflow route", async ({ page }) => {
  await setup(page, "installer");
  await page.goto("/workflow");
  await expect(
    page.getByRole("heading", { name: "Not available for your role" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Workflow", exact: true }),
  ).toHaveCount(0);
});

test("new-job dialog captures a service call and supports cancellation", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/workflow");
  await hideWrongProjectBanner(page);
  await page.getByRole("button", { name: "Add job", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add job" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Add job", exact: true }).click();
  await dialog.getByLabel("Job name").fill("Service visit");
  await dialog.getByLabel("Work type").selectOption("service_call");
  await dialog.getByRole("button", { name: "Create job" }).click();
  await expect(
    page.getByRole("heading", { name: "Service visit", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Work type")).toHaveValue("service_call");
});

test("partner Workflow shows shared proposals and approves the exact start date", async ({
  page,
}) => {
  await configureSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await page.route("**/rest/v1/rpc/is_partner_user", (r) => json(r, true));
  const job = {
    ...initial(),
    start_precision: "date",
    target_start: "2026-12-01",
    bids: [
      {
        id: "bid1",
        number: "P-101",
        revision: 1,
        amount: 500,
        scope: "Install phase A",
        accepted_at: null,
      },
    ],
    files: [],
  };
  await page.route("**/rest/v1/rpc/stg_workflow", (r) => json(r, [job]));
  let sent: Record<string, unknown> | undefined;
  await page.route("**/rest/v1/rpc/stg_workflow_reply", (r) => {
    sent = r.request().postDataJSON();
    return json(r, null);
  });
  await page.goto("/stg");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Mesa Heights" }),
  ).toBeVisible();
  await page.getByText("Proposals (1)", { exact: true }).click();
  await expect(page.getByText("P-101 · revision 1 · $500.00")).toBeVisible();
  await page
    .getByLabel("Response for Mesa Heights")
    .fill("December 1 works. Access will be ready.");
  await page.getByRole("button", { name: "Approve start 2026-12-01" }).click();
  await expect(page.getByRole("status")).toHaveText("Response saved.");
  expect(sent).toMatchObject({
    p_job: ID,
    p_version: 1,
    p_confirm_date: true,
    p_note: "December 1 works. Access will be ready.",
  });
  await expect(page.getByRole("link", { name: "Warehouse" })).toHaveCount(0);
  await page.screenshot({
    path: "../../../outputs/STG_Workflow_Phone_Preview.png",
    fullPage: true,
  });
});

test("supervisor shares a job with a named partner without sending email", async ({
  page,
}) => {
  await setup(page);
  let sent: Record<string, unknown> | undefined;
  await page.route("**/rest/v1/rpc/proposal_share", (r) => {
    sent = r.request().postDataJSON();
    return json(r, null);
  });
  await page.goto("/workflow");
  await page.getByRole("button", { name: "Mesa Heights", exact: true }).click();
  await page.getByRole("button", { name: "Sharing", exact: true }).click();
  await page.getByLabel("Partner login email").fill("partner@example.test");
  await page.getByRole("button", { name: "Save sharing", exact: true }).click();
  await expect(
    page.getByText("Sharing saved. No email was sent.", { exact: true }),
  ).toBeVisible();
  expect(sent).toMatchObject({
    p_job: ID,
    p_version: 1,
    p_email: "partner@example.test",
    p_bids: [],
    p_documents: [],
    p_remove: false,
  });
});

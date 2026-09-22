import { expect, test } from "@playwright/test";
import { useSupabaseFixtures, TEST_USER } from "./support/supabaseFixtures";
test.setTimeout(45000);
const job = "20000000-0000-4000-8000-000000000002",
  guide = "30000000-0000-4000-8000-000000000003";
for (const width of [390, 1440])
  test(`Hex-Portal exact guidance, durable case and outcome at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 960 });
    await useSupabaseFixtures(page, { role: "installer" });
    const cases: Record<string, unknown>[] = [];
    const outcomes: Record<string, unknown>[] = [];
    await page.route("**/rest/v1/projects**", (route) =>
      route.fulfill({
        json: [
          {
            id: job,
            job_code: "DECK",
            name: "Synthetic deck",
            status: "active",
            is_test: false,
          },
        ],
      }),
    );
    await page.route("**/rest/v1/hex_portal_cases**", (route) =>
      route.fulfill({
        json: cases.map((c) => ({ ...c, hex_portal_outcomes: outcomes })),
      }),
    );
    await page.route("**/functions/v1/hex-portal", async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        projectId: job,
        question: "What is the reviewed flashing lesson?",
      });
      await route.fulfill({
        json: {
          enabled: true,
          items: [
            {
              id: guide,
              revision: 4,
              title: "Reviewed flashing",
              answer: "Use the synthetic reviewed procedure.",
              applicability: "Synthetic deck only",
              evidence: "Fixture checklist r4",
              reviewBy: "2099-01-01",
            },
          ],
        },
      });
    });
    await page.route("**/rest/v1/rpc/hex_portal_save_case", async (route) => {
      const b = route.request().postDataJSON();
      expect(b.p_sources).toEqual([
        {
          id: guide,
          revision: 4,
          title: "Reviewed flashing",
          kind: "hex-portal",
        },
      ]);
      expect(b.p_unit_label).toBe("16");
      if (!cases.some((c) => c.id === b.p_id))
        cases.push({
          id: b.p_id,
          asker_id: TEST_USER.id,
          project_id: b.p_project_id,
          unit_label: b.p_unit_label,
          question: b.p_question,
          answer: b.p_answer,
          created_at: new Date().toISOString(),
        });
      await route.fulfill({ json: b.p_id });
    });
    await page.route(
      "**/rest/v1/rpc/hex_portal_save_outcome",
      async (route) => {
        const b = route.request().postDataJSON();
        expect(b.p_case_id).toBe(cases[0].id);
        outcomes.push({
          id: b.p_id,
          outcome: b.p_outcome,
          explanation: b.p_explanation,
          created_at: new Date().toISOString(),
        });
        await route.fulfill({ json: b.p_id });
      },
    );
    await page.goto("/ask");
    await page
      .getByText("Hex-Portal · Learn from this job", { exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Job", exact: true })
      .selectOption(job);
    await page.getByLabel("Unit (optional)").fill("16");
    const input = page.locator(".ask-input input");
    await input.fill("What is the reviewed flashing lesson?");
    await input.press("Enter");
    await expect(page.locator(".ask-thread")).toContainText(
      "Reviewed Hexcore guidance · exact revisions",
    );
    await expect(page.locator(".ask-thread")).toContainText(
      "Fixture checklist r4",
    );
    await page.getByRole("button", { name: "Save Hex-Portal case" }).click();
    await expect.poll(() => cases.length).toBe(1);
    await page
      .getByLabel("What happened next?")
      .fill("The synthetic detail still leaks.");
    await page.getByRole("button", { name: "Needs help", exact: true }).click();
    await expect.poll(() => outcomes.length).toBe(1);
    expect(outcomes[0].outcome).toBe("needs-help");
    await page.reload();
    await page
      .getByText("Hex-Portal · Learn from this job", { exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Job", exact: true })
      .selectOption(job);
    await page
      .getByText("My latest 50 learning cases", { exact: true })
      .click();
    await expect(page.locator(".hex-learning-panel")).toContainText(
      "The synthetic detail still leaks.",
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  });
test("a private hours question never goes to the learning bridge or gets a shared case button", async ({
  page,
}) => {
  await useSupabaseFixtures(page, { role: "owner" });
  let bridge = 0;
  await page.route("**/rest/v1/projects**", (route) =>
    route.fulfill({
      json: [
        {
          id: job,
          job_code: "DECK",
          name: "Synthetic deck",
          status: "active",
          is_test: false,
        },
      ],
    }),
  );
  await page.route("**/rest/v1/hex_portal_cases**", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/functions/v1/hex-portal", (route) => {
    bridge++;
    return route.fulfill({ json: { enabled: true, items: [] } });
  });
  await page.route("**/functions/v1/ask", (route) =>
    route.fulfill({ json: { answer: "Private recorded hours.", sources: [] } }),
  );
  await page.goto("/ask");
  await page
    .getByText("Hex-Portal · Learn from this job", { exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Job", exact: true })
    .selectOption(job);
  const input = page.locator(".ask-input input");
  await input.fill("Show my payroll hours this week");
  await input.press("Enter");
  await expect(page.locator(".ask-thread")).toContainText(
    "Private recorded hours.",
  );
  expect(bridge).toBe(0);
  await expect(
    page.getByRole("button", { name: "Save Hex-Portal case" }),
  ).toHaveCount(0);
});

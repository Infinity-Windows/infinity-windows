import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  await page.goto("/e2e/support/unit-review-forms.html");
  await expect(page.getByTestId("unit-verification-fields")).toBeVisible();
});
async function fillEvidence(page: Page, width = "72") {
  const form = page.getByTestId("unit-verification-fields");
  await form.getByLabel("Width", { exact: true }).fill(width);
  await form.getByLabel("Height", { exact: true }).fill("96");
  await form.getByLabel("Measurement unit", { exact: true }).selectOption("in");
  await form.getByLabel("Evidence source", { exact: true }).selectOption("measured");
  await form.getByLabel("Where did you check these dimensions?", { exact: true }).fill("Tape measured both frame edges");
}
async function fits(page: Page) {
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
    outside: [...document.querySelectorAll<HTMLElement>('main *')].filter(e => e.getClientRects().length > 0 && (e.getBoundingClientRect().left < -.1 || e.getBoundingClientRect().right > innerWidth + .1)).map(e => e.tagName) }))).toEqual({ width: page.viewportSize()!.width, document: page.viewportSize()!.width, outside: [] });
  const controls = await page.locator('main input:not([type="checkbox"]), main select, main textarea, main button').evaluateAll(nodes => nodes.filter(e => e.getClientRects().length).map(e => ({ tag: e.tagName, height: e.getBoundingClientRect().height })));
  expect(controls.filter(c => c.height < 44)).toEqual([]);
}
test("independent measured corroboration captures one exact basis and awaits parent confirmation", async ({ page }) => {
  await fillEvidence(page);
  await page.getByRole("button", { name: "Send dimension verification", exact: true }).click();
  await expect(page.getByTestId("intent-count")).toHaveText("1");
  const intents = JSON.parse(await page.getByTestId("intent-json").innerText());
  expect(intents[0]).toMatchObject({ action: "verify_dimensions", basis: { unitId: "synthetic-unit-42", factRevision: 4, scopeToken: "opaque-fixture-server-token" }, data: { widthDecimal: "72", heightDecimal: "96", unit: "in", source: "measured" } });
  expect(intents[0]).not.toHaveProperty("verified");
  await expect(page.getByRole("button", { name: "Send dimension verification", exact: true })).toBeDisabled();
  await expect(page.getByTestId("unit-verification-fields")).toContainText("Estimated");
});
test("mismatch, self and unknown observer refuse dimension verification", async ({ page }) => {
  await fillEvidence(page, "72.00001"); await expect(page.getByRole("button", { name: "Send dimension verification", exact: true })).toBeDisabled();
  await expect(page.getByTestId("unit-verification-fields")).toContainText("Record a new size observation first");
  await page.getByRole("button", { name: "Self observer", exact: true }).click(); await fillEvidence(page); await expect(page.getByTestId("unit-verification-fields")).toContainText("Another authorized person");
  await page.getByRole("button", { name: "Unknown observer", exact: true }).click(); await fillEvidence(page); await expect(page.getByTestId("unit-verification-fields")).toContainText("original observer is unknown");
  await expect(page.getByTestId("intent-count")).toHaveText("0");
});
test("final QC permits authorized self review but correction claims never pass", async ({ page }) => {
  await page.getByRole("button", { name: "Self observer", exact: true }).click();
  await page.getByRole("button", { name: "Record final QC pass", exact: true }).click();
  await expect(page.getByTestId("intent-count")).toHaveText("1");
  expect(JSON.parse(await page.getByTestId("intent-json").innerText())[0].action).toBe("pass");
  await page.getByRole("button", { name: "Failed state", exact: true }).click();
  await page.getByTestId("unit-qc-review-fields").getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Submit corrections for review", exact: true }).click();
  await expect(page.getByTestId("intent-count")).toHaveText("2");
  expect(JSON.parse(await page.getByTestId("intent-json").innerText())[1]).toMatchObject({ action: "claim_resolved", data: { defectIds: ["fixture-defect-1"] } });
  await expect(page.getByTestId("unit-qc-review-fields")).toContainText("Corrections required");
});
test("failure needs stable defects and reopen needs a reason", async ({ page }) => {
  const qc = page.getByTestId("unit-qc-review-fields");
  await expect(qc.getByRole("button", { name: "Record defects / fail QC", exact: true })).toBeDisabled();
  await qc.getByLabel("Review note or correction explanation", { exact: true }).fill("Bottom seal needs a correction");
  await qc.getByRole("button", { name: "Add defect", exact: true }).click();
  await qc.getByLabel("Defect 1", { exact: true }).fill("Incomplete backer rod");
  await qc.getByRole("button", { name: "Record defects / fail QC", exact: true }).click();
  const intent = JSON.parse(await page.getByTestId("intent-json").innerText())[0]; expect(intent).toMatchObject({ action: "fail", data: { defects: [{ summary: "Incomplete backer rod" }] } }); expect(intent.data.defects[0].id).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Passed state", exact: true }).click(); await expect(qc.getByRole("button", { name: "Reopen final QC", exact: true })).toBeDisabled();
  await qc.getByLabel("Review note or correction explanation", { exact: true }).fill("More unit work was recorded"); await qc.getByRole("button", { name: "Reopen final QC", exact: true }).click();
  await expect(page.getByTestId("intent-count")).toHaveText("2");
});
test("unknown delivery, stale source and changed actor block actions and old drafts", async ({ page }) => {
  await fillEvidence(page); await page.getByRole("button", { name: "Unknown delivery", exact: true }).click(); await expect(page.getByRole("button", { name: "Send dimension verification", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Stale basis", exact: true }).click(); await expect(page.getByTestId("unit-verification-fields").getByRole("textbox")).toHaveCount(0); await expect(page.getByTestId("unit-verification-fields")).not.toContainText("Fixture plan reference");
  await page.getByRole("button", { name: "Reset fixture", exact: true }).click(); await fillEvidence(page); await page.getByRole("button", { name: "Change actor", exact: true }).click();
  await expect(page.getByTestId("unit-verification-fields").getByRole("textbox")).toHaveCount(0); await expect(page.getByTestId("intent-count")).toHaveText("0");
});
test("EN ES controls, raw references and long defect text fit 320 390 and landscape", async ({ page }) => {
  for (const language of ["en", "es"]) {
    if (language === "es") await page.getByRole("button", { name: "Change language", exact: true }).click();
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport); await fits(page);
    }
    await page.getByRole("button", { name: "Failed state", exact: true }).click(); await fits(page);
    await page.screenshot({ path: test.info().outputPath(`${language}-unit-review.png`), fullPage: true });
    await page.getByRole("button", { name: "Reset fixture", exact: true }).click();
  }
});

test("typing and language switches keep controlled evidence without creating a review", async ({ page }) => {
  await fillEvidence(page);
  const form = page.getByTestId("unit-verification-fields");
  await form.getByLabel("Width", { exact: true }).fill("72.");
  await expect(form.getByLabel("Width", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Change language", exact: true }).click();
  await expect(form.getByLabel("Ancho", { exact: true })).toHaveValue("72.");
  await expect(form.getByLabel("¿Dónde verificaste estas medidas?", { exact: true })).toHaveValue("Tape measured both frame edges");
  await expect(page.getByTestId("intent-count")).toHaveText("0");
  await page.getByRole("button", { name: "Toggle authority", exact: true }).click();
  await expect(form.getByRole("button", { name: "Enviar verificación de medidas", exact: true })).toBeDisabled();
});


test("precision beyond JavaScript numbers stays exact on screen and in transport", async ({ page }) => {
  await page.getByRole("button", { name: "Precision observation", exact: true }).click();
  await fillEvidence(page, "1.00000000000000001");
  await page.getByRole("button", { name: "Send dimension verification", exact: true }).click();
  expect(JSON.parse(await page.getByTestId("intent-json").innerText())[0].data.widthDecimal).toBe("1.00000000000000001");
  await expect(page.getByTestId("unit-verification-fields")).toContainText("1.00000000000000001");
});

test("partial correction claims await the remaining crew work and a distinct reviewer decision", async ({ page }) => {
  const qc = page.getByTestId("unit-qc-review-fields");
  await page.getByRole("button", { name: "Failed state", exact: true }).click();
  await qc.getByRole("checkbox").first().check();
  await qc.getByRole("button", { name: "Submit corrections for review", exact: true }).click();
  await expect(qc).toContainText("Corrections required");
  await page.getByRole("button", { name: "Confirmed partial claim", exact: true }).click();
  await expect(qc.getByRole("checkbox")).toHaveCount(1);
  await expect(qc).toContainText("Claimed corrected — needs review");
  await expect(qc).toContainText("Some defects still need correction");
  await qc.getByRole("checkbox").check();
  await qc.getByRole("button", { name: "Submit corrections for review", exact: true }).click();
  await page.getByRole("button", { name: "Confirmed all claims", exact: true }).click();
  await qc.getByRole("button", { name: "Record final QC pass", exact: true }).click();
  const intents = JSON.parse(await page.getByTestId("intent-json").innerText());
  expect(intents[2]).toMatchObject({ action: "pass", basis: { generation: 2, submissionId: "synthetic-submission-2" }, data: { note: null } });
  await expect(qc).toContainText("Claimed corrected — needs review");
  await expect(qc).not.toContainText("Correction verified");
  await page.getByRole("button", { name: "Confirmed reviewer pass", exact: true }).click();
  await expect(qc).toContainText("Correction verified");
  await qc.getByLabel("Review note or correction explanation", { exact: true }).fill("New work needs review");
  await qc.getByRole("button", { name: "Reopen final QC", exact: true }).click();
  await expect(qc).toContainText("Correction verified");
  expect(JSON.parse(await page.getByTestId("intent-json").innerText())[3].action).toBe("reopen");
});

test("reviewer can reject real correction claims without fabricating a new defect", async ({ page }) => {
  const qc = page.getByTestId("unit-qc-review-fields");
  await page.getByRole("button", { name: "Failed state", exact: true }).click();
  await page.getByRole("button", { name: "Confirmed all claims", exact: true }).click();
  await qc.getByLabel("Review note or correction explanation", { exact: true }).fill("The reported correction still leaks");
  await qc.getByRole("button", { name: "Record defects / fail QC", exact: true }).click();
  expect(JSON.parse(await page.getByTestId("intent-json").innerText())[0]).toMatchObject({ action: "fail", data: { note: "The reported correction still leaks", defects: [] } });
  await expect(qc.getByRole("textbox", { name: "Defect 1", exact: true })).toHaveCount(0);
});

import { expect, test, type Page } from "@playwright/test";
import type { PanelFixture } from "./support/unitReviewPanelHarness";
type Fixture = PanelFixture;
async function open(page: Page) {
  await page.route("**/*", route => new URL(route.request().url()).hostname === "localhost" ? route.continue() : route.abort());
  await page.goto("/e2e/support/unit-review-panel.html");
  await expect(page.getByTestId("unit-review-current")).toBeVisible();
}
async function verification(page: Page, note = "Independent tape at frame") {
  const form = page.getByTestId("unit-verification-fields");
  await form.getByRole("textbox", { name: "Width", exact: true }).fill("0001.00000000000000000100");
  await form.getByRole("textbox", { name: "Height", exact: true }).fill("72.00");
  await form.getByLabel("Evidence source", { exact: true }).selectOption("measured");
  await form.getByRole("textbox", { name: "Where did you check these dimensions?", exact: true }).fill(note);
  await form.getByRole("button", { name: "Send dimension verification", exact: true }).click();
}
const rows = (page: Page) => page.evaluate(() => { const f: Fixture = window.unitReviewPanelFixture; return f.storage.readReviewJournal(f.auth.signInMark(), f.UNIT, () => true); });

test("actual forms retain exact original and pending intent before send; receipts cannot set current trust", async ({ page }) => {
  await open(page); await verification(page);
  await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  const calls = await page.evaluate(() => window.unitReviewPanelFixture.calls);
  expect(calls).toHaveLength(1); expect(calls[0].durable).toBe(true);
  expect(calls[0].payload.data).toMatchObject({ widthDecimal: "1.000000000000000001", heightDecimal: "72", sourceReference: "Independent tape at frame" });
  await expect(page.getByTestId("unit-review-current")).toContainText("Dimensions are not currently verified");
  await expect(page.getByTestId("unit-review-current")).toContainText("Final QC is not currently accepted");
  await page.evaluate(() => { const f = window.unitReviewPanelFixture, v = f.current(); v.review.dimensionVerification = { state: "verified", verificationId: f.id(60) }; v.review.qc = { state: "passed", acceptance: "accepted", lifecycle: "proven", qcAccepted: true }; f.setCurrent(v); });
  await page.getByRole("button", { name: "Check current review", exact: true }).click();
  await expect(page.getByTestId("unit-review-current")).toContainText("Final QC currently accepted");
  expect((await rows(page))[0].attempts).toHaveLength(1);
});

test("lost response reload recovers the same UUID by receipt only and never resends", async ({ page }) => {
  await open(page); await page.evaluate(() => window.unitReviewPanelFixture.mode("lost")); await verification(page);
  await expect(page.getByTestId("unit-review-history")).toContainText("Outcome unknown"); const original = (await rows(page))[0];
  await page.reload(); await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  expect(await page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(0);
  expect((await rows(page))[0].commandId).toBe(original.commandId);
});

test("unknown head blocks new decisions; stale hidden original closes only by explicit cancellation", async ({ page }) => {
  await open(page); await page.evaluate(() => window.unitReviewPanelFixture.mode("unknown")); await verification(page, "PRIVATE RETAINED TEXT");
  await expect(page.getByTestId("unit-review-history")).toContainText("Outcome unknown");
  await expect(page.getByRole("button", { name: "Submit for final QC", exact: true })).toBeDisabled();
  const original = (await rows(page))[0];
  await page.evaluate(() => { const f = window.unitReviewPanelFixture, v = f.current(); v.review.basis!.scopeToken = `ur1:${"b".repeat(64)}`; v.review.basis!.reviewRevision++; f.setCurrent(v); });
  await page.getByRole("button", { name: "Check current review", exact: true }).click();
  await expect(page.getByTestId("unit-review-hidden")).toBeVisible();
  await expect(page.getByTestId("unit-review-panel")).not.toContainText("PRIVATE RETAINED TEXT");
  await expect(page.getByTestId("unit-review-history")).toHaveCount(0);
  expect(await page.evaluate(() => window.unitReviewPanelFixture.cancels())).toBe(0);
  await page.getByRole("button", { name: "Cancel saved request", exact: true }).click();
  await expect(page.getByTestId("unit-review-history")).toContainText("Cancelled receipt recorded");
  const after = (await rows(page))[0]; expect(after.commandId).toBe(original.commandId); expect(after.attempts.map(a => a.outcome)).toEqual(["unknown", "cancelled"]);
  await expect(page.getByRole("button", { name: "Submit for final QC", exact: true })).toBeEnabled();
});

test("cancellation honestly returns original-first application and preserves uncertain history", async ({ page }) => {
  await open(page); await page.evaluate(() => window.unitReviewPanelFixture.mode("lost")); await verification(page);
  await expect(page.getByTestId("unit-review-history")).toContainText("Outcome unknown");
  await expect(page.getByTestId("unit-review-history")).toContainText("If the review already applied, it stays applied");
  await page.getByRole("button", { name: "Cancel saved request", exact: true }).click();
  await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  expect((await rows(page))[0].attempts.map(a => a.outcome)).toEqual(["unknown", "recorded"]);
});

test("two tabs respect the live native lease and neither check nor duplicate tap resends", async ({ page, context }) => {
  await open(page); await page.evaluate(() => window.unitReviewPanelFixture.mode("wait")); await verification(page);
  await expect.poll(async () => page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(1);
  const other = await context.newPage(); await open(other); await expect(other.getByTestId("unit-review-history")).toContainText("Outcome unknown");
  await other.getByRole("button", { name: "Retry the same request", exact: true }).click();
  await expect(other.getByTestId("unit-review-history")).toContainText("Outcome unknown");
  expect(await other.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(0);
  await page.evaluate(() => window.unitReviewPanelFixture.releaseSend()); await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  await other.getByRole("button", { name: "Check current review", exact: true }).click();
  await expect(other.getByTestId("unit-review-history")).toContainText("Applied receipt recorded"); expect((await rows(page))[0].attempts).toHaveLength(1);
});

test("native strict durability refusal prevents dispatch and gives recoverable storage wording", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { const original = IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction = function (...args: Parameters<typeof original>) { const tx = original.apply(this, args); if (args[1] === "readwrite") Object.defineProperty(tx, "durability", { value: "relaxed" }); return tx; }; });
  await verification(page); await expect(page.getByTestId("unit-review-panel")).toContainText("could not safely retain");
  expect(await page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(0);
  expect(await rows(page)).toEqual([]);
});

test("definite first refusal permits a new decision while unknown then refusal never does", async ({ page }) => {
  await open(page); await page.evaluate(() => window.unitReviewPanelFixture.mode("refused")); await verification(page);
  await expect(page.getByTestId("unit-review-history")).toContainText("no earlier uncertain attempt");
  await expect(page.getByRole("button", { name: "Submit for final QC", exact: true })).toBeEnabled();
  await page.evaluate(() => window.unitReviewPanelFixture.mode("unknown")); await page.getByRole("button", { name: "Submit for final QC", exact: true }).click();
  await expect(page.getByTestId("unit-review-history")).toContainText("Outcome unknown");
  await page.evaluate(() => window.unitReviewPanelFixture.mode("refused")); await page.getByRole("button", { name: "Retry the same request", exact: true }).click();
  await expect(page.getByRole("button", { name: "Submit for final QC", exact: true })).toBeDisabled();
  expect((await rows(page))[1].attempts.map(a => a.outcome)).toEqual(["unknown", "refused"]);
});

test("batched preview/person and real-role ABA remove drafts and ignore a late read", async ({ page }) => {
  await open(page); await page.getByRole("textbox", { name: "Width", exact: true }).fill("98765");
  await page.evaluate(() => { const f = window.unitReviewPanelFixture; f.holdReads(); f.preview().setPreviewRole("installer"); f.preview().setPreviewRole(null); });
  await expect(page.getByRole("textbox", { name: "Width", exact: true })).toHaveCount(0);
  await page.evaluate(() => { const f = window.unitReviewPanelFixture; f.preview().setPreviewPerson({ id: f.id(88), role: "installer", name: "Person" }); f.preview().setPreviewPerson(null); f.profile("installer"); f.profile("owner"); f.releaseReads(); });
  await expect(page.getByRole("textbox", { name: "Width", exact: true })).toHaveValue("");
  expect(await page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(0);
});

test("owner ABA, selection lifetime, offline and background erase exposure and never auto-send", async ({ page, context }) => {
  await open(page); await page.getByRole("textbox", { name: "Width", exact: true }).fill("98765");
  await page.evaluate(() => { const f = window.unitReviewPanelFixture; f.auth.rememberSignedIn(null); f.auth.rememberSignedIn({ user: { id: f.OWNER } }); });
  await expect(page.getByRole("textbox", { name: "Width", exact: true })).toHaveCount(0);
  await page.evaluate(() => window.unitReviewPanelFixture.select()); await expect(page.getByRole("textbox", { name: "Width", exact: true })).toHaveValue("");
  await page.evaluate(() => window.unitReviewPanelFixture.source.invalidate()); await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
  await page.evaluate(() => window.unitReviewPanelFixture.select()); await expect(page.getByTestId("unit-review-current")).toBeVisible();
  await context.setOffline(true); await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
  await context.setOffline(false); await expect(page.getByTestId("unit-review-current")).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(page.getByTestId("unit-review-current")).toBeVisible(); expect(await page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(0);
});

for (const lang of ["en", "es"] as const) for (const width of [320, 390]) test(`actual forms fit ${lang} at ${width}px and reduced height`, async ({ page }) => {
  await page.setViewportSize({ width, height: 420 }); await open(page); await page.evaluate(language => window.unitReviewPanelFixture.language(language), lang);
  await expect(page.getByRole("heading", { name: lang === "en" ? "Verify unit dimensions" : "Verificar medidas de la unidad", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const buttons = await page.locator('[data-testid="unit-review-panel"] button').evaluateAll(elements => elements.map(e => e.getBoundingClientRect().height));
  expect(buttons.every(height => height >= 44)).toBe(true);
  await page.getByRole("button", { name: lang === "en" ? "Submit for final QC" : "Enviar a revisión final", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `../../outputs/Forge-Redesign-Implementation-2026-10-03/UNIT-REVIEW-PANEL-${lang}-${width}.png`, fullPage: true });
});


test("late send completion after preview ABA cannot expose the old result or create another send", async ({ page }) => {
  await open(page); await page.evaluate(() => window.unitReviewPanelFixture.mode("wait")); await verification(page, "PRIVATE LATE NOTE");
  await expect.poll(() => page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(1);
  await page.evaluate(() => window.unitReviewPanelFixture.preview().setPreviewRole("installer"));
  await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
  await page.evaluate(() => window.unitReviewPanelFixture.releaseSend());
  await expect(page.getByTestId("unit-review-panel")).not.toContainText("PRIVATE LATE NOTE");
  const pending = (await rows(page))[0]; expect(pending.attempts[0].outcome).toBe("pending");
  await page.evaluate(() => window.unitReviewPanelFixture.preview().setPreviewRole(null));
  await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  expect(await page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(1);
});

test("independent observer rule blocks self dimensions while authorized foreman can submit own QC", async ({ page }) => {
  await open(page); await page.evaluate(() => { const f = window.unitReviewPanelFixture; f.profile("foreman"); f.current().review.observation!.observerId = f.OWNER; f.select(f.UNIT, f.JOB, "foreman"); });
  await expect(page.getByTestId("unit-verification-fields")).toContainText("Another authorized person must verify");
  await expect(page.getByRole("button", { name: "Send dimension verification", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Submit for final QC", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Submit for final QC", exact: true }).click();
  await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  expect((await rows(page))[0].payload.action).toBe("submit");
});


test("freshness expiry removes sensitive forms without polling or automatic delivery", async ({ page }) => {
  await page.clock.install(); await open(page);
  const reads = await page.evaluate(() => window.unitReviewPanelFixture.reads());
  await page.clock.fastForward(30001);
  await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
  expect(await page.evaluate(() => window.unitReviewPanelFixture.reads())).toBe(reads);
  expect(await page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(0);
  await page.getByRole("button", { name: "Check current review", exact: true }).click();
  await expect(page.getByTestId("unit-review-current")).toBeVisible();
});

test("hidden finished older verification does not block a visible terminal head or a new decision", async ({ page }) => {
  await open(page); await verification(page, "PRIVATE OLDER VERIFICATION");
  await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  const old = (await rows(page))[0];
  await page.getByRole("textbox", { name: "Review note or correction explanation", exact: true }).fill("VISIBLE LATEST REVIEW");
  await page.getByRole("button", { name: "Submit for final QC", exact: true }).click();
  await expect.poll(async () => (await rows(page)).length).toBe(2);
  await expect(page.getByTestId("unit-review-history").locator("article")).toHaveCount(2);
  await page.evaluate(commandId => { const f = window.unitReviewPanelFixture; f.hideReceipt(commandId); f.current().review.basis!.scopeToken = `ur1:${"c".repeat(64)}`; f.current().review.basis!.reviewRevision = 2; }, old.commandId);
  await page.getByRole("button", { name: "Check current review", exact: true }).click();
  await expect(page.getByTestId("unit-review-hidden")).toHaveCount(0);
  await expect(page.getByTestId("unit-review-history").locator("article")).toHaveCount(1);
  await expect(page.getByTestId("unit-review-history")).not.toContainText("PRIVATE OLDER VERIFICATION");
  await expect(page.getByTestId("unit-review-panel")).not.toContainText(old.commandId);
  await expect(page.getByRole("button", { name: "Submit for final QC", exact: true })).toBeEnabled();
  await verification(page, "NEW CURRENT VERIFICATION");
  await expect.poll(async () => (await rows(page)).length).toBe(3);
  await expect(page.getByTestId("unit-review-history")).not.toContainText("PRIVATE OLDER VERIFICATION");
});

test("hidden older row never weakens an unresolved newest head", async ({ page }) => {
  await open(page); await verification(page, "PRIVATE OLDER VERIFICATION");
  await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded"); const old = (await rows(page))[0];
  await page.evaluate(() => window.unitReviewPanelFixture.mode("unknown"));
  await page.getByRole("button", { name: "Submit for final QC", exact: true }).click();
  await expect(page.getByTestId("unit-review-history")).toContainText("Outcome unknown");
  await page.evaluate(commandId => { const f = window.unitReviewPanelFixture; f.hideReceipt(commandId); f.current().review.capabilities.verifyDimensions = false; }, old.commandId);
  await page.getByRole("button", { name: "Check current review", exact: true }).click();
  await expect(page.getByTestId("unit-review-hidden")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submit for final QC", exact: true })).toBeDisabled();
  await expect(page.getByTestId("unit-review-history")).toContainText("Outcome unknown");
  await expect(page.getByTestId("unit-review-history")).not.toContainText("PRIVATE OLDER VERIFICATION");
  expect((await rows(page)).length).toBe(2);
});

test("installer explicitly returns from suppressed stale role/person preview without gaining preview rights", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    sessionStorage.setItem("infinity.viewAsRole", "owner");
    sessionStorage.setItem("infinity.viewAsPerson", JSON.stringify({ id: "00000000-0000-4000-8000-000000000099", role: "installer", name: "Stale private person" }));
  });
  await page.reload();
  await page.waitForFunction(() => !!window.unitReviewPanelFixture?.preview());
  await page.evaluate(() => { const f = window.unitReviewPanelFixture; f.profile("installer"); f.select(f.UNIT, f.JOB, "installer"); });
  await expect(page.getByTestId("unit-review-current")).toHaveCount(0);
  expect(await page.evaluate(() => window.unitReviewPanelFixture.preview().previewRole)).toBeNull();
  expect(await page.evaluate(() => window.unitReviewPanelFixture.preview().previewPerson)).toBeNull();
  await page.getByRole("button", { name: "Return as yourself", exact: true }).click();
  await expect(page.getByTestId("unit-review-current")).toBeVisible();
  expect(await page.evaluate(() => [sessionStorage.getItem("infinity.viewAsRole"), sessionStorage.getItem("infinity.viewAsPerson")])).toEqual([null, null]);
  await page.evaluate(() => window.unitReviewPanelFixture.preview().setPreviewRole("owner"));
  expect(await page.evaluate(() => window.unitReviewPanelFixture.preview().previewRole)).toBeNull();
  expect(await page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(0);
});

test("applied decision resets draft even when the server fixture returns an unchanged basis", async ({ page }) => {
  await open(page); const basis = await page.evaluate(() => window.unitReviewPanelFixture.current().review.basis);
  await verification(page, "DO NOT REUSE THIS DRAFT");
  await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  expect(await page.evaluate(() => window.unitReviewPanelFixture.current().review.basis)).toEqual(basis);
  await expect(page.getByRole("textbox", { name: "Width", exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Where did you check these dimensions?", exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Send dimension verification", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.unitReviewPanelFixture.calls.length)).toBe(1);
});

test("resolved defect history uses fresh authorized summaries instead of internal UUIDs", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const f = window.unitReviewPanelFixture, v = f.current();
    v.review.qc = { state: "failed", acceptance: "not_accepted", lifecycle: "proven", qcAccepted: false };
    v.review.basis!.generation = 1; v.review.basis!.submissionId = f.id(50);
    v.review.capabilities = { verifyDimensions: false, submit: false, pass: false, fail: false, claimResolved: true, reopen: false };
    v.review.defects = [{ id: f.id(51), summary: "Seal the lower left corner", state: "open" }, { id: f.id(52), summary: "Check the other corner", state: "open" }];
  });
  await page.getByRole("button", { name: "Check current review", exact: true }).click();
  await page.getByRole("checkbox", { name: "Seal the lower left corner", exact: true }).check();
  await page.getByRole("button", { name: "Submit corrections for review", exact: true }).click();
  await expect(page.getByTestId("unit-review-history")).toContainText("Applied receipt recorded");
  await expect(page.getByTestId("unit-review-history")).toContainText("Seal the lower left corner");
  await expect(page.getByTestId("unit-review-history")).not.toContainText("00000000-0000-4000-8000-000000000051");
});

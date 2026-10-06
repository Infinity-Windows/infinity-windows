import { expect, test, type Page, type Route } from "@playwright/test";
import { FIXTURE_AUTH_KEY, FIXTURE_SESSION, TEST_USER } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";

const PROJECT = "00000000-0000-4000-8000-000000000301";
const SHIFT = "00000000-0000-4000-8000-000000000302";
const SELECTION = "00000000-0000-4000-8000-000000000303";
const MENU = "00000000-0000-4000-8000-000000000304";
const DEFINITION = "00000000-0000-4000-8000-000000000305";
const VERSION = "00000000-0000-4000-8000-000000000306";
const TRANSITION = "00000000-0000-4000-8000-000000000307";
const OBSERVATION = "00000000-0000-4000-8000-000000000308";
const UNIT = "00000000-0000-4000-8000-000000000309";
const FACT = "00000000-0000-4000-8000-000000000310";
const SPECIFIC_DEFINITION = "00000000-0000-4000-8000-000000000311";
const SPECIFIC_VERSION = "00000000-0000-4000-8000-000000000312";
const utc = (date = new Date()) => date.toISOString().replace("Z", "000Z");
type CommandArgs = { p_command_id: string; p_protocol_version: number; p_payload: {
  deviceId: string; clientGeneration: string; clientSequence: number;
  predecessorCommandId: string | null; intent: { kind: string };
} };
function receipt(commandId: string, before: number) {
  return { protocolVersion: 1, availability: "available", receipt: {
    protocolVersion: 1, commandId, status: "applied", reasonCode: null,
    beforeRevision: before, afterRevision: before + 1,
    transitionId: TRANSITION, effectiveAt: utc(),
  } };
}
function unavailableReceipt() { return { protocolVersion: 1, availability: "unavailable", receipt: null }; }
type UnitCommandArgs = { p_id: string; p_action: string; p_data: Record<string, unknown> };
interface FixtureLog { commands: CommandArgs[]; committed: boolean[]; receipts: string[]; unexpected: string[]; mismatchBasis: boolean;
  unitCommands: UnitCommandArgs[]; unitCommitted: boolean[]; allowUnitReply: boolean }
function unitBasis(bindingEpoch = 3) { return { id: UNIT, projectId: PROJECT, openingId: null,
  operationalRevision: 5, incarnationEpoch: 2, bindingEpoch, projectEpoch: 1, openingEpoch: null,
  fact: { id: FACT, revision: 2, eventKind: "observation", originProjectEpoch: 1, originOpeningEpoch: null,
    dimensions: { widthIn: 10, heightIn: 20, source: "measured",
      original: { width: 10, height: 20, unit: "in", source: "measured", sourceReference: null } }, estimated: false },
  eligibleForCapture: true, ineligibleReason: null }; }
async function setup(page: Page): Promise<FixtureLog> {
  const log: FixtureLog = { commands: [], committed: [], receipts: [], unexpected: [], mismatchBasis: false,
    unitCommands: [], unitCommitted: [], allowUnitReply: false };
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)),
    { key: FIXTURE_AUTH_KEY, session: FIXTURE_SESSION });
  let revision = 0;
  let stream: { clientGeneration: string; headSequence: number; headCommandId: string; headAfterRevision: number; status: "active" } | null = null;
  const applied = new Map<string, ReturnType<typeof receipt>>();
  const unitReceipts = new Set<string>();
  let unitRevision = 5, factRevision = 2;
  let original = { width: 10, height: 20, unit: "in", source: "measured", sourceReference: null as string | null };
  const inches = (n: number) => original.unit === "in" ? n : original.unit === "ft" ? n * 12 : n / (original.unit === "mm" ? 25.4 : 2.54);
  const currentUnitBasis = (epoch = 3) => ({ ...unitBasis(epoch), operationalRevision: unitRevision,
    fact: { ...unitBasis(epoch).fact, revision: factRevision, estimated: original.source === "estimated",
      dimensions: { widthIn: inches(original.width), heightIn: inches(original.height), source: original.source, original } } });
  const snapshot = (deviceId: string) => {
    const now = new Date(), asOf = utc(now), issuedAt = utc(new Date(now.getTime() - 1000)),
      expiresAt = utc(new Date(now.getTime() + 10 * 60_000));
    return { protocolVersion: 1, asOf, deviceId,
      capability: { mode: "active", reasonCode: null },
      observation: { id: OBSERVATION, revision, lastTransitionId: revision ? TRANSITION : null,
        issuedAt, expiresAt, shiftRef: { kind: "shift", id: SHIFT },
        currentGeneration: stream?.clientGeneration ?? null, currentHeadCommandId: stream?.headCommandId ?? null },
      stream,
      state: { revision, lastTransitionId: revision ? TRANSITION : null, integrity: "clean",
        status: "unclassified", choiceRequired: true,
        actions: { canEstablishStream: revision === 0, canSwitch: revision > 0,
          canFinishSetup: false, canStop: false },
        shift: { id: SHIFT, clockInCommandId: null, clockInAt: utc(new Date(now.getTime() - 60_000)),
          breakStartedAt: null, breakType: null, status: "open",
          project: { visibility: "available", id: PROJECT, name: "Synthetic project", jobCode: "E2E" } },
        activity: null } };
  };
  const catalog = (unitId: string | null) => ({ protocolVersion: 1, asOf: utc(), availability: "available",
    projectId: PROJECT, unit: unitId === UNIT ? currentUnitBasis() : null,
    selection: { selectionId: SELECTION, selectionRevision: 2, menuVersionId: MENU, eligibleNow: true,
      activities: [{ definitionId: DEFINITION, definitionVersionId: VERSION, position: 0, enabled: true,
        scope: "general", labelEn: "Framing a deliberately long aluminum assembly", labelEs: "Enmarcar un conjunto de aluminio excepcionalmente largo",
        machineSelection: false, typedFields: [], eligibleNow: true, ineligibleReason: null },
      { definitionId: SPECIFIC_DEFINITION, definitionVersionId: SPECIFIC_VERSION, position: 1, enabled: true,
        scope: "specific", labelEn: "Set this unit in the opening", labelEs: "Colocar esta unidad en el vano",
        machineSelection: false, typedFields: [], eligibleNow: unitId === UNIT,
        ineligibleReason: unitId === UNIT ? null : "unit_required" }] },
    totals: { availability: "unavailable", reasonCode: "not_ready" } });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
    log.unexpected.push(url.href);
    return route.abort();
  });
  await page.route("**/rest/v1/rpc/work_activity_snapshot", (route) => {
    const args = route.request().postDataJSON() as { p_device_id: string };
    return json(route, snapshot(args.p_device_id), null);
  });
  await page.route("**/rest/v1/rpc/work_activity_catalog", (route) => {
    const args = route.request().postDataJSON() as { p_project_id: string; p_unit_id: string | null };
    return json(route, args.p_project_id === PROJECT && (args.p_unit_id === null || args.p_unit_id === UNIT) ? catalog(args.p_unit_id)
      : { protocolVersion: 1, asOf: utc(), availability: "unavailable", projectId: null, unit: null,
          selection: null, totals: { availability: "unavailable", reasonCode: "not_ready" } }, null);
  });
  await page.route("**/rest/v1/rpc/work_activity_unit_basis", (route) => {
    const args = route.request().postDataJSON() as { p_unit_id: string };
    return json(route, args.p_unit_id === UNIT
      ? { protocolVersion: 1, asOf: utc(), availability: "available", unit: currentUnitBasis(log.mismatchBasis ? 4 : 3) }
      : { protocolVersion: 1, asOf: utc(), availability: "unavailable", unit: null }, null);
  });
  await page.route("**/rest/v1/rpc/work_unit_fact_current_read", (route) => {
    expect(route.request().postDataJSON()).toEqual({ p_unit_id: UNIT });
    return json(route, { protocolVersion: 1, unitId: UNIT, revision: factRevision, eventKind: "observation",
      observation: { ...original, estimated: original.source === "estimated" }, widthIn: inches(original.width),
      heightIn: inches(original.height), observationActorId: TEST_USER.id, recordedAt: utc() }, null);
  });
  await page.route("**/rest/v1/custom_work_units?**", (route) => {
    expect(new URL(route.request().url()).searchParams.get("id")).toBe(`eq.${UNIT}`);
    return json(route, { id: UNIT, project_id: PROJECT, opening_id: null, created_by: TEST_USER.id,
      label: "Unit 12", type_label: "Aluminum", revision: unitRevision,
      facts: { width_in: inches(original.width), height_in: inches(original.height), note: "Keep original note" },
      created_at: utc(), updated_at: utc() }, null);
  });
  await page.route("**/rest/v1/rpc/custom_work_command", async (route) => {
    const args = route.request().postDataJSON() as UnitCommandArgs;
    log.unitCommands.push(args);
    const stored = await page.evaluate((owner) => JSON.parse(localStorage.getItem(`forge-custom-work-v1:${owner}`) ?? "[]"), TEST_USER.id);
    log.unitCommitted.push(stored.some((row: { id: string; action: string; data: unknown }) =>
      row.id === args.p_id && row.action === args.p_action && JSON.stringify(row.data) === JSON.stringify(args.p_data)));
    if (!log.allowUnitReply) return route.abort("failed");
    if (!unitReceipts.has(args.p_id)) {
      expect(args.p_action).toBe("unit"); expect(args.p_data.id).toBe(UNIT);
      expect(args.p_data.revision).toBe(unitRevision); expect(args.p_data.expected_fact_revision).toBe(factRevision);
      original = args.p_data.dimension_observation as typeof original;
      unitRevision++; factRevision++; unitReceipts.add(args.p_id);
    }
    return json(route, UNIT, null);
  });
  await page.route("**/rest/v1/rpc/work_activity_command_receipt", (route) => {
    const args = route.request().postDataJSON() as { p_command_id: string };
    log.receipts.push(args.p_command_id);
    return json(route, applied.get(args.p_command_id) ?? unavailableReceipt(), null);
  });
  await page.route("**/rest/v1/rpc/work_activity_command", async (route: Route) => {
    const args = route.request().postDataJSON() as CommandArgs;
    log.commands.push(args);
    const row = await page.evaluate(async ({ owner, deviceId }) => {
      // @ts-expect-error Vite browser module URL is intentionally absent from Node types.
      const { getCurrentActivityCommand } = await import("/src/lib/workActivity/journal.ts");
      return getCurrentActivityCommand(owner, deviceId);
    }, { owner: TEST_USER.id, deviceId: args.p_payload.deviceId });
    log.committed.push(row?.commandId === args.p_command_id &&
      JSON.stringify(row?.payload) === JSON.stringify(args.p_payload) && row?.uncertain === true);
    if (args.p_payload.intent.kind === "establish_stream") {
      const answer = receipt(args.p_command_id, revision);
      applied.set(args.p_command_id, answer);
      revision++;
      stream = { clientGeneration: args.p_payload.clientGeneration, headSequence: args.p_payload.clientSequence,
        headCommandId: args.p_command_id, headAfterRevision: revision, status: "active" };
      return json(route, answer, null);
    }
    return route.abort("failed");
  });
  return log;
}
async function open(page: Page) {
  await page.goto("/e2e/support/selected-job-work.html");
  await expect(page.getByTestId("project-activity-view")).toBeVisible();
}
async function fits(page: Page) {
  // WebKit can finish setViewportSize before its next layout is committed.
  // Require the same zero-overflow result after layout; persistent overflow
  // still fails and reports every offending element, including fixture controls.
  try { await expect.poll(() => page.evaluate(() => ({
    overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    outside: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((e) => e.getClientRects().length && (e.getBoundingClientRect().left < -.1 ||
        e.getBoundingClientRect().right > innerWidth + .1))
      .map((e) => e.tagName + "." + e.className),
  }))).toEqual({ overflow: 0, outside: [] }); }
  catch (error) {
    const measure = () => page.evaluate(() => {
      const elements = [...document.querySelectorAll<HTMLElement>("html,body,body *")];
      return {
        viewport: { innerWidth, outerWidth, scrollX, rootClient: document.documentElement.clientWidth,
          rootScroll: document.documentElement.scrollWidth, bodyClient: document.body.clientWidth, bodyScroll: document.body.scrollWidth,
          visual: window.visualViewport ? { width: visualViewport!.width, scale: visualViewport!.scale, offsetLeft: visualViewport!.offsetLeft } : null },
        active: document.activeElement?.outerHTML,
        overflowing: elements.filter(e => e.getClientRects().length && (e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > innerWidth + .1))
          .map(e => { const rect=e.getBoundingClientRect(), css=getComputedStyle(e); return { tag:e.tagName, class:e.className,
            text:e.textContent?.slice(0,80), scroll:e.scrollWidth, client:e.clientWidth, rect:{left:rect.left,right:rect.right,width:rect.width},
            width:css.width,minWidth:css.minWidth,maxWidth:css.maxWidth,overflow:css.overflow,font:css.fontSize,position:css.position,
            before:getComputedStyle(e,"::before").content,after:getComputedStyle(e,"::after").content }; }),
      };
    });
    console.log("[selected-job-layout/focused]", JSON.stringify(await measure()));
    await page.screenshot({ path:"e2e/test-results/selected-job-layout-failure-focused.png",fullPage:true });
    // Diagnostic only, after the original failure: establish whether focused
    // native input state causes the width without allowing the test to pass.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    console.log("[selected-job-layout/blurred]", JSON.stringify(await measure()));
    throw error;
  }
}
async function privateCache(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify((window as Window & { readPrivateCache?: () => unknown }).readPrivateCache?.() ?? []));
}

test("native journal commit precedes RPC; unknown start blocks descendants and remount only looks up receipt", async ({ page }) => {
  const log = await setup(page); await open(page);
  const reaffirm = page.getByRole("button", { name: "Reaffirm activity stream" });
  await expect(reaffirm).toBeVisible();
  expect(log.commands).toHaveLength(0);
  await reaffirm.click();
  await expect(page.getByRole("button", { name: "Framing a deliberately long aluminum assembly" })).toBeEnabled();
  expect(log.commands).toHaveLength(1);
  expect(log.committed).toEqual([true]);
  expect(log.commands[0].p_payload.intent.kind).toBe("establish_stream");
  const tile = page.getByRole("button", { name: "Framing a deliberately long aluminum assembly" });
  await tile.click();
  await expect(tile).toBeDisabled();
  await expect.poll(() => log.commands.length).toBe(2);
  // The command route logs each attempt BEFORE awaiting its native journal
  // read, then logs the witness. Wait for that read to finish; the boolean
  // vector below stays synchronous so a completed false still fails at once.
  await expect.poll(() => ({ attempts: log.commands.length, witnesses: log.committed.length })).toEqual({ attempts: 2, witnesses: 2 });
  expect(log.commands).toHaveLength(2);
  expect(log.committed).toEqual([true, true]);
  const original = structuredClone(log.commands[1]);
  await page.getByRole("button", { name: "Remount Work" }).click();
  await expect(page.getByRole("button", { name: "Check receipt and retry original request" })).toBeVisible();
  await expect.poll(() => log.receipts).toContain(original.p_command_id);
  expect(log.commands).toHaveLength(2); // receipt read cannot resend the uncertain command
  await page.getByRole("button", { name: "Check receipt and retry original request" }).click();
  await expect.poll(() => log.commands.length).toBe(3);
  // Same settlement: the third witness is logged only after its native read.
  await expect.poll(() => ({ attempts: log.commands.length, witnesses: log.committed.length })).toEqual({ attempts: 3, witnesses: 3 });
  expect(log.commands).toHaveLength(3);
  expect(log.commands[2]).toEqual(original);
  expect(log.committed).toEqual([true, true, true]);
  expect(log.unexpected).toEqual([]);
});

test("Specific uses the exact current ten-token basis and refuses catalog/basis drift", async ({ page }) => {
  const log = await setup(page); await open(page);
  await page.getByRole("button", { name: "Reaffirm activity stream" }).click();
  await expect(page.getByRole("button", { name: "Framing a deliberately long aluminum assembly" })).toBeEnabled();
  log.mismatchBasis = true;
  await page.getByRole("tab", { name: "Specific" }).click();
  await page.getByRole("combobox", { name: "Choose a unit" }).selectOption(UNIT);
  const tile = page.getByRole("button", { name: "Set this unit in the opening" });
  await expect(tile).toBeDisabled();
  expect(log.commands).toHaveLength(1);
  log.mismatchBasis = false;
  await page.getByRole("button", { name: "Remount Work" }).click();
  await page.getByRole("tab", { name: "Specific" }).click();
  await page.getByRole("combobox", { name: "Choose a unit" }).selectOption(UNIT);
  await expect(tile).toBeEnabled();
  await tile.click();
  await expect.poll(() => log.commands.length).toBe(2);
  // The command route logs the attempt before awaiting its native journal
  // read; wait for the witness before the synchronous boolean check below.
  await expect.poll(() => ({ attempts: log.commands.length, witnesses: log.committed.length })).toEqual({ attempts: 2, witnesses: 2 });
  expect(log.commands).toHaveLength(2);
  const intent = log.commands[1].p_payload.intent as unknown as { scope: string; unit: Record<string, unknown> };
  expect(intent.scope).toBe("specific");
  expect(intent.unit).toEqual({ id: UNIT, operationalRevision: 5, factId: FACT, factRevision: 2,
    incarnationEpoch: 2, bindingEpoch: 3, projectEpoch: 1, openingEpoch: null,
    originProjectEpoch: 1, originOpeningEpoch: null });
  expect(log.committed).toEqual([true, true]);
  expect(log.unexpected).toEqual([]);
});

test("selected-unit dimensions use the canonical durable queue and hold Specific through a lost reply and remount", async ({ page, context }) => {
  const log = await setup(page); await open(page);
  await page.getByRole("button", { name: "Reaffirm activity stream" }).click();
  await expect(page.getByRole("button", { name: "Framing a deliberately long aluminum assembly" })).toBeEnabled();
  const specific = page.getByRole("tab", { name: "Specific" });
  await specific.click();
  await expect(specific).toHaveAttribute("aria-selected", "true");
  await page.getByRole("combobox", { name: "Choose a unit" }).selectOption(UNIT);
  const tile = page.getByRole("button", { name: "Set this unit in the opening" });
  await expect(tile).toBeEnabled();
  await page.getByRole("button", { name: "Enter dimensions", exact: true }).click();
  await page.getByLabel("Width", { exact: true }).fill("500");
  await page.getByLabel("Height", { exact: true }).fill("1000");
  await page.getByLabel("Measurement unit", { exact: true }).selectOption("mm");
  await page.getByLabel("Dimension source", { exact: true }).selectOption("estimated");
  await page.getByLabel("Source reference (optional)", { exact: true }).fill("Synthetic plan A-12");
  for (const locale of ["en", "es"] as const) {
    if (locale === "es") await page.getByRole("button", { name: "Change language" }).click();
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport); await fits(page);
      console.log("[selected-job-layout/picker-fit]", JSON.stringify(await page.evaluate(() => ({
        viewport:innerWidth, documentScroll:document.documentElement.scrollWidth,
        picker:[...document.querySelectorAll<HTMLElement>(".pav-unit-picker, .pav-unit-picker select, .pav-unit-picker button")].map(e=>({
          tag:e.tagName,class:e.className,scroll:e.scrollWidth,client:e.clientWidth,
          rect:{left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right},appearance:getComputedStyle(e).appearance,
        })),
      }))));
      if (viewport.width === 320) await page.screenshot({ path: `e2e/test-results/selected-unit-dimensions-${locale}-320.png`, fullPage: true });
    }
  }
  await page.getByRole("button", { name: "Change language" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Width", { exact: true })).toHaveValue("500");
  await page.getByRole("button", { name: "Save dimension request", exact: true }).click();
  await expect.poll(() => log.unitCommands.length).toBe(1);
  await expect.poll(() => log.unitCommitted).toEqual([true]);
  const saved = structuredClone(log.unitCommands[0]);
  expect(saved.p_action).toBe("unit");
  expect(saved.p_data).toMatchObject({ id: UNIT, revision: 5, expected_fact_revision: 2,
    facts: { note: "Keep original note" }, dimension_observation: {
      width: 500, height: 1000, unit: "mm", source: "estimated", sourceReference: "Synthetic plan A-12" } });
  expect(saved.p_data.facts).not.toHaveProperty("width_in");
  await expect(tile).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save dimension request", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Remount Work" }).click();
  await page.getByRole("tab", { name: "Specific" }).click();
  await page.getByRole("combobox", { name: "Choose a unit" }).selectOption(UNIT);
  await expect(tile).toBeDisabled();
  await expect(page.getByRole("button", { name: "Enter dimensions", exact: true })).toBeDisabled();
  expect(log.unitCommands).toHaveLength(1);
  log.allowUnitReply = true;
  await page.getByRole("button", { name: "Retry saved unit requests", exact: true }).click();
  await expect.poll(() => log.unitCommands.length).toBe(2);
  expect(log.unitCommands[1]).toEqual(saved); // same canonical UUID and frozen payload
  // The route logs its incoming command before awaiting the native commit
  // check. Wait for that exact check too, without accepting an uncommitted send.
  await expect.poll(() => log.unitCommitted).toEqual([true, true]);
  await page.getByRole("button", { name: "Refresh current unit", exact: true }).click();
  await expect(page.getByText("500 × 1000 mm", { exact: false })).toBeVisible();
  await expect(page.getByText("Estimate — not verified", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter dimensions", exact: true })).toBeEnabled();
  await expect(tile).toBeEnabled();
  expect(log.commands).toHaveLength(1); // recording dimensions never starts activity
  await context.setOffline(true);
  await expect(page.getByText("500 × 1000 mm", { exact: false })).toHaveCount(0);
  await expect.poll(() => privateCache(page)).not.toContain(TEST_USER.id);
  expect(await privateCache(page)).not.toContain(PROJECT);
  expect(await privateCache(page)).not.toContain(UNIT);
  await page.getByRole("button", { name: "Clock out", exact: true }).click();
  await expect(page.getByTestId("controls-json")).toHaveText('["out"]');
  expect(log.unexpected).toEqual([]);
});

test("phone layouts and private auth/offline boundaries keep independent controls callable", async ({ page, context }) => {
  const log = await setup(page); await open(page);
  await page.getByRole("button", { name: "Reaffirm activity stream" }).click();
  const tile = page.getByRole("button", { name: "Framing a deliberately long aluminum assembly" });
  await expect(tile).toBeVisible();
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); await fits(page);
  }
  await page.getByRole("button", { name: "Change language" }).click();
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toBeVisible();
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); await fits(page);
  }
  await page.getByRole("button", { name: "Toggle preview" }).click();
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle preview" }).click();
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toHaveCount(0);
  await expect.poll(() => privateCache(page)).not.toContain(TEST_USER.id);
  expect(await privateCache(page)).not.toContain(PROJECT);
  expect(await privateCache(page)).not.toContain(UNIT);
  for (const name of ["Tu reloj", "Descanso", "Marcar salida", "Horario", "Preguntar"])
    await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByTestId("controls-json")).toHaveText('["clock","break","out","schedule","ask"]');
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toBeVisible();
  await page.getByRole("button", { name: "Leave Work" }).click();
  await expect.poll(() => privateCache(page)).not.toContain(TEST_USER.id);
  expect(await privateCache(page)).not.toContain(PROJECT);
  expect(await privateCache(page)).not.toContain(UNIT);
  await page.getByRole("button", { name: "Return to Work" }).click();
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toBeVisible();
  await page.getByRole("button", { name: "Change job" }).click();
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toHaveCount(0);
  await page.getByRole("button", { name: "Change job" }).click();
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toBeVisible();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Enmarcar un conjunto de aluminio excepcionalmente largo" })).toHaveCount(0);
  await expect.poll(() => privateCache(page)).not.toContain(TEST_USER.id);
  expect(await privateCache(page)).not.toContain(PROJECT);
  expect(await privateCache(page)).not.toContain(UNIT);
  await page.getByRole("button", { name: "Tu reloj", exact: true }).click();
  await expect(page.getByTestId("controls-json")).toContainText('"clock"');
  expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.includes("workActivityPrivate")))).toBe(false);
  expect(log.unexpected).toEqual([]);
});

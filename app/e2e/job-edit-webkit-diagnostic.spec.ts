import { expect, test, type Page } from "@playwright/test";
import { jobFixtures, useSupabaseFixtures } from "./support/supabaseFixtures";
import { hideWrongProjectBanner, json } from "./support/specHelpers";

const job = jobFixtures().find((row) => row.jobCode === "BLACK22")!;
type Evidence = { rows: unknown[]; forbiddenWrites: unknown[]; navigations: unknown[]; truncated: boolean };
const evidence = new WeakMap<Page, Evidence>();
export function forbiddenWrite(url: URL, method: string) {
  const path = url.pathname.replace(/\/$/, "");
  return (path === "/rest/v1/projects" && method !== "GET") ||
    /^\/rest\/v1\/rpc\/(?:set|delete|restore)_projects?(?:_|$)/.test(path) ||
    /\/rest\/v1\/rpc\/(?:delete_test_project|.*(?:project.*(?:status|finish|complete|cancel|delete|lifecycle)|(?:finish|complete|cancel|delete).*project))$/.test(path);
}

export function summarizeJobEditEvents(inputRows: Record<string, any>[], mode: string) {
  // Browser chronology is only meaningful within one document. Node-side
  // records have wall times but are not spliced into browser event windows.
  const browser = inputRows.filter(row => typeof row.documentId === "string" && Number.isInteger(row.sequence))
    .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.sequence - b.sequence);
  const documents = [...new Set(browser.map(row => row.documentId))];
  const duplicateSequences = browser.some((row, index) => index > 0 && row.documentId === browser[index - 1].documentId && row.sequence === browser[index - 1].sequence);
  const releaseRequested = browser.some(row => row.kind === "artificial-module-release-request");
  const releaseAcknowledged = browser.some(row => row.kind === "artificial-module-release-ack");
  const probeMiss = mode !== "natural-instrumented" && (!releaseRequested || !releaseAcknowledged);
  const interactions: Record<string, any>[] = [];
  let editIntentSeen = false;
  const finish = (span: Record<string, any>[]) => {
    if (!span.length) return;
    const approach = span.find(row => row.kind === "mousemove" && row.target?.text?.trim() === "Edit");
    const baseline = approach ?? span[0];
    const down = span.find(row => row.kind === "pointerdown");
    const up = span.find(row => row.kind === "pointerup");
    const click = span.find(row => row.kind === "click");
    const moved = (rows: Record<string, any>[]) => ["edit", "finish", "cancelJob"].filter(key => rows.some(row =>
      row[key]?.rect && baseline[key]?.rect && ["x", "y", "width", "height"].some(d => Math.abs(row[key].rect[d] - baseline[key].rect[d]) > 0.5)));
    const movedControls = moved(span), movedBeforePress = moved(down ? span.filter(row => row.sequence <= down.sequence) : span);
    const positions = span.filter(row => row.kind === "above-or-watched-dom-change").flatMap(row =>
      (row.changes ?? []).flatMap((change: any) => change.type === "childList"
        ? [...(change.added ?? []), ...(change.removed ?? [])].map((node: any) => node.position)
        : [change.targetPosition]));
    const reasons: string[] = [];
    if (down && (down.target?.id !== baseline.edit?.node?.id || down.target?.text?.trim() !== "Edit")) reasons.push("wrong_press_target");
    if (down && up && down.target?.id !== up.target?.id) reasons.push("press_release_target_difference");
    if (down && !click) reasons.push("press_without_click");
    if (approach && !down) reasons.push("approach_without_press");
    if (down && click && down.target?.id !== click.target?.id) reasons.push("press_click_target_difference");
    if (down && click && !up) reasons.push("incomplete_input_sequence");
    if (movedBeforePress.length) reasons.push("movement_before_press");
    else if (movedControls.length) reasons.push("movement_during_press");
    interactions.push({ documentId: baseline.documentId, approachSeen: !!approach,
      baselineSequence: baseline.sequence, endSequence: span.at(-1)?.sequence,
      down: down?.target ?? null, up: up?.target ?? null, click: click?.target ?? null,
      completed: !!click, movedControls, movedBeforePress, reasons,
      mutations: { before: positions.filter(p => p === "before").length, contains: positions.filter(p => p === "contains" || p === "self" || p === "inside").length,
        after: positions.filter(p => p === "after").length, unknown: positions.filter(p => !p || p === "unknown").length,
        onlyAfter: positions.length > 0 && positions.every(p => p === "after") } });
  };
  for (const documentId of documents) {
    let armed = false, span: Record<string, any>[] = [];
    for (const row of browser.filter(row => row.documentId === documentId)) {
      if (row.kind === "phase" && row.label === "edit-action-start") { finish(span); span = []; armed = true; editIntentSeen = true; continue; }
      if (!armed) continue;
      if (row.kind === "phase" && row.label === "edit-action-returned") { finish(span); span = []; armed = false; continue; }
      const approach = row.kind === "mousemove" && row.target?.text?.trim() === "Edit";
      if (approach && span.some(event => event.kind === "pointerdown")) { finish(span); span = []; }
      if (!span.length && (approach || row.kind === "pointerdown")) span = [row];
      else if (span.length) span.push(row);
      if (row.kind === "click" && span.length) { finish(span); span = []; }
    }
    finish(span);
  }
  const reviewReasons = new Set<string>();
  for (const documentId of documents) {
    let armed = false, editTargetClick = false, editorSeen = false, beforeCancel = false;
    for (const row of browser.filter(item => item.documentId === documentId)) {
      if (row.kind === "phase" && row.label === "edit-action-start") {
        armed = true; editTargetClick = false; editorSeen = false; beforeCancel = true;
      }
      if (!beforeCancel) continue;
      if (row.kind === "click" && row.target?.text?.trim() === "Cancel") { beforeCancel = false; armed = false; continue; }
      if (armed && row.kind === "details-dom-identity-change") reviewReasons.add("details_dom_identity_change_during_edit_action");
      if (armed && row.kind === "click" && row.target?.text?.trim() === "Edit" && row.target?.id === row.edit?.node?.id) editTargetClick = true;
      if (row.heading?.trim() === "Edit job details") editorSeen = true;
      else if (editorSeen && row.heading?.trim() === "Job details") reviewReasons.add("editor_reverted_before_cancel");
      if (row.kind === "phase" && row.label === "edit-action-returned") {
        if (editTargetClick && row.heading?.trim() !== "Edit job details") reviewReasons.add("editor_not_open_at_action_return");
        armed = false;
      }
    }
  }
  const anomaly = interactions.some(row => row.reasons.length > 0);
  return { interpretation: probeMiss ? "PROBE_MISS_INCONCLUSIVE"
      : documents.length > 1 || duplicateSequences ? "DOCUMENT_COVERAGE_UNKNOWN_REVIEW_REQUIRED"
      : reviewReasons.size ? "EDIT_OUTCOME_REVIEW_REQUIRED"
      : anomaly ? "INPUT_OR_MOVEMENT_ANOMALY_REVIEW_REQUIRED"
      : !editIntentSeen ? "NO_EDIT_ACTION_EVIDENCE_INCONCLUSIVE" : "NO_CAUSAL_EVENT_CAPTURED_INCONCLUSIVE",
    mode, probeMiss, releaseRequested, releaseAcknowledged, documents, duplicateSequences,
    browserRows: browser.length, nodeRowsExcludedFromWindows: inputRows.length - browser.length,
    playwrightActionLogReview: "UNREVIEWED: inspect passing trace action logs and pw:api retry logs; this event summary cannot establish absence of internal retries",
    naturalSuccessEligible: false, instrumentationForcesLayout: true, reviewReasons: [...reviewReasons], interactions };
}

test.beforeEach(async ({ page }) => {
  const state: Evidence = { rows: [], forbiddenWrites: [], navigations: [], truncated: false };
  evidence.set(page, state);
  const append = (row: unknown) => {
    if (state.rows.length < 20000) state.rows.push(row); else state.truncated = true;
  };
  await page.exposeFunction("emitJobEditEvidence", append);
  page.on("request", request => {
    const url = new URL(request.url());
    if (forbiddenWrite(url, request.method())) {
      const write = { kind: "FORBIDDEN_WRITE", wallTime: Date.now(), method: request.method(), path: url.pathname };
      state.forbiddenWrites.push(write); append(write);
    }
  });
  page.on("framenavigated", frame => {
    const row = { kind: "framenavigated", wallTime: Date.now(), main: frame === page.mainFrame(), url: frame.url() };
    state.navigations.push(row); append(row);
  });
  page.on("console", message => {
    if (/vite|reload|optimiz/i.test(message.text())) append({ kind: "vite-console", wallTime: Date.now(), type: message.type(), text: message.text() });
  });
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    if (url.hostname === "localhost" && url.port === "5297") socket.on("framereceived", event => {
      const payload = event.payload.toString();
      if (/full-reload|reload|update|error/.test(payload)) append({ kind: "vite-websocket-message", wallTime: Date.now(), payload });
    });
  });
  page.on("pageerror", error => append({ kind: "pageerror", wallTime: Date.now(), message: error.message }));
  // Terminal network deny is installed FIRST. Later fixture handlers answer
  // mocked Supabase traffic; any escaped external request reaches this abort.
  await page.route("**/*", route => new URL(route.request().url()).origin === "http://localhost:5297"
    ? route.fallback() : route.abort("blockedbyclient"));
  await page.routeWebSocket("**/*", socket => {
    const url = new URL(socket.url());
    // Preserve localhost Vite reload behavior: blocking its socket would hide
    // precisely the dev-server reload mechanism this probe must observe.
    if (url.hostname === "localhost" && url.port === "5297") socket.connectToServer();
    else socket.close();
  });
});

test.afterEach(async ({ page }, info) => {
  const state = evidence.get(page);
  if (!state) return;
  const fs = await import("node:fs/promises");
  // Every browser record is also streamed to Node, so a reload cannot erase
  // the previous document's pointer or node-identity evidence.
  await page.screenshot({ path: info.outputPath("final.png") }).catch(() => {});
  await page.evaluate(() => (window as any).flushJobEditEvidence?.()).catch(() => {});
  await fs.writeFile(info.outputPath("events.json"), JSON.stringify(state, null, 2));
  const summary = summarizeJobEditEvents(state.rows as Record<string, any>[], info.title.startsWith("natural-instrumented:") ? "natural-instrumented" : "artificial");
  await fs.writeFile(info.outputPath("event-summary.json"), JSON.stringify(summary, null, 2));
  expect(state.forbiddenWrites, "No project write or lifecycle call at any point in this case").toEqual([]);
  expect(state.truncated, "A truncated event stream is not usable evidence").toBe(false);
});

for (const mode of ["natural-instrumented", "release-pointerdown", "release-mousemove"] as const) for (const width of [390, 1280]) {
  test(`${mode}: job overview stays centered and readable at ${width}px`, async ({ page }) => {
    const state = evidence.get(page)!;
    let released = false;
    const pendingModules: (() => Promise<void>)[] = [];
    await page.exposeFunction("releaseDiagnosticLazy", async () => {
      released = true;
      await Promise.all(pendingModules.splice(0).map(fulfill => fulfill()));
    });
    if (mode !== "natural-instrumented") await page.route(/\/src\/components\/(?:workConfiguration\/WorkJobConfiguration|projects\/CrewGoalCard)\.tsx(?:\?|$)/, async route => {
      const response = await route.fetch(); // localhost Vite module only
      const fulfill = () => route.fulfill({ response });
      if (released) await fulfill(); else pendingModules.push(fulfill);
    });
    await page.addInitScript(({ mode }) => {
      const documentId = crypto.randomUUID();
      const ids = new WeakMap<Node, number>(); let nextId = 1, sequence = 0;
      let sampling = false, frame = 0, releaseRequested = false, approachArmed = false;
      let delivery: Promise<unknown> = Promise.resolve();
      const identify = (node: Node | null) => {
        if (!node) return null;
        if (!ids.has(node)) ids.set(node, nextId++);
        const el = node instanceof Element ? node : node.parentElement;
        return { id: ids.get(node), tag: el?.tagName, cls: String(el?.className ?? ""), ariaLabel: el?.getAttribute("aria-label"), text: node.textContent?.slice(0, 120), connected: node.isConnected };
      };
      const rect = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      };
      const namedButton = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === label) ?? null;
      const controls = () => {
        const card = document.querySelector(".job-details-card");
        const edit = card?.querySelector(".job-details-header button") ?? null;
        const finish = namedButton("Finish this job…"), cancelJob = namedButton("Cancel this job…");
        return { card: identify(card), heading: card?.querySelector("h2")?.textContent,
          edit: { node: identify(edit), rect: rect(edit) }, finish: { node: identify(finish), rect: rect(finish) }, cancelJob: { node: identify(cancelJob), rect: rect(cancelJob) }, scrollY };
      };
      const record = (kind: string, extra: Record<string, unknown> = {}) => {
        const row = { documentId, sequence: sequence++, timeOrigin: performance.timeOrigin, t: performance.now(), kind, ...controls(), ...extra };
        delivery = Promise.all([delivery, (window as any).emitJobEditEvidence(row)]);
      };
      (window as any).flushJobEditEvidence = () => delivery;
      window.addEventListener("pagehide", () => record("pagehide"));
      (window as any).markJobEditEvidence = (label: string) => {
        if (label === "edit-action-start") approachArmed = true;
        if (label === "edit-action-returned") { approachArmed = false; sampling = false; cancelAnimationFrame(frame); }
        record("phase", { label });
      };
      const tick = () => { if (sampling) { record("interaction-animation-frame"); frame = requestAnimationFrame(tick); } };
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "mousemove"]) window.addEventListener(type, (event: Event) => {
        const ev = event as MouseEvent;
        const target = ev.target instanceof Element ? ev.target : null;
        const editApproach = type === "mousemove" && target?.closest(".job-details-header button")?.textContent?.trim() === "Edit";
        if (type === "mousemove" && !editApproach && !approachArmed) return;
        if ((editApproach && approachArmed || type === "pointerdown") && !sampling) { sampling = true; frame = requestAnimationFrame(tick); }
        // These rect/elementFromPoint reads can force layout and perturb event
        // timing. Only the unchanged original spec is an uninstrumented control.
        record(type, { trusted: ev.isTrusted, x: ev.clientX, y: ev.clientY, target: identify(target), hit: identify(document.elementFromPoint(ev.clientX, ev.clientY)) });
        if (type === "click") { sampling = false; cancelAnimationFrame(frame); record("interaction-click-complete"); }
        if (!releaseRequested && target?.closest(".job-details-header button")?.textContent?.trim() === "Edit" &&
          ((mode === "release-pointerdown" && type === "pointerdown") || (mode === "release-mousemove" && type === "mousemove"))) {
          releaseRequested = true; record("artificial-module-release-request", { mode });
          void (window as any).releaseDiagnosticLazy().then(() => record("artificial-module-release-ack", { mode }));
        }
      }, true);
      window.addEventListener("scroll", () => record("scroll"), true);
      let lastCard: Element | null = null;
      new MutationObserver(changes => {
        const card = document.querySelector(".job-details-card");
        const previousCard = lastCard;
        if (card !== lastCard) { record("details-dom-identity-change", { previous: identify(lastCard), next: identify(card) }); lastCard = card; }
        const relativeToCard = (node: Node | null): string => {
          if (!node || !card) return "unknown";
          if (node === card) return "self";
          if (node.contains(card)) return "contains";
          if (card.contains(node)) return "inside";
          const position = node.compareDocumentPosition(card);
          if (position & Node.DOCUMENT_POSITION_DISCONNECTED) return "unknown";
          return position & Node.DOCUMENT_POSITION_FOLLOWING ? "before" : "after";
        };
        const removedPosition = (node: Node, change: MutationRecord) => {
          const direct = relativeToCard(node);
          if (direct !== "unknown") return { position: direct, positionBasis: "connected-node" };
          const parent = relativeToCard(change.target);
          if (["before", "after", "inside"].includes(parent)) return { position: parent, positionBasis: "mutation-parent" };
          const next = relativeToCard(change.nextSibling), previous = relativeToCard(change.previousSibling);
          if (["before", "self"].includes(next)) return { position: "before", positionBasis: "next-sibling-inference" };
          if (["after", "self"].includes(previous)) return { position: "after", positionBasis: "previous-sibling-inference" };
          return { position: "unknown", positionBasis: "detached-without-unambiguous-neighbor" };
        };
        // Capture every mutation with its own position. Shared parent contains
        // Job details does NOT make a newly inserted below-card child "above".
        if (card || previousCard) record("above-or-watched-dom-change", { changes: changes.map(change => ({
          type: change.type, attribute: change.attributeName, target: identify(change.target), targetPosition: relativeToCard(change.target),
          added: [...change.addedNodes].map(node => ({ node: identify(node), position: relativeToCard(node), positionBasis: "connected-node" })),
          removed: [...change.removedNodes].map(node => ({ node: identify(node), ...removedPosition(node, change) })),
        })) });
      }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      record("document-instrumentation-start", { mode, forcedLayoutInstrumentation: true });
    }, { mode });

    await page.setViewportSize({ width, height: 844 });
    const newDesign = width === 390;
    await useSupabaseFixtures(page, { role: "owner", uiDesign: newDesign ? "new" : "classic" });
    await page.route("**/rest/v1/company_settings**", route => json(route, { id: 1, new_design_r1_enabled: true }, 1));
    await hideWrongProjectBanner(page);
    await page.addInitScript(() => localStorage.setItem("infinity.theme", "dark"));
    const project = { id: job.projectId, job_code: "BLACK22", name: "Black Desert", status: "active", allowed_modes: [width >= 430 ? "data" : "tracking"], is_test: false,
      start_date: "2026-08-05", end_date: "2026-08-26", customer_name: "Site office", contact_email: width === 390 ? "office@example.com" : `${"long-contact".repeat(12)}@example.com`,
      notes: width === 390 ? "Confirm access with the site office." : "LongJobReference".repeat(24) };
    await page.route("**/rest/v1/projects**", route => json(route, [project], 1));
    let releaseData = () => {};
    const dataGate = new Promise<void>(resolve => { releaseData = resolve; });
    // Artificial cases also hold these fixture READS until a draft exists.
    // This proves draft preservation through data settlement; it must not be
    // reported as a natural timing observation or an operational API call.
    if (mode !== "natural-instrumented") await page.route(/\/rest\/v1\/rpc\/(crew_goal_summary|work_job_menu_choices|work_job_capability_grants)(?:\?|$)/, async route => {
      state.rows.push({ kind: "artificial-data-read-held", wallTime: Date.now(), path: new URL(route.request().url()).pathname });
      await dataGate;
      await route.fallback();
    });
    let crewFinished = () => {};
    const crewResponseFinished = new Promise<void>(resolve => { crewFinished = resolve; });
    page.on("response", response => {
      if (new URL(response.url()).pathname === "/rest/v1/rpc/crew_goal_summary") void response.finished().then(() => {
        state.rows.push({ kind: "crew-response-finished", wallTime: Date.now(), status: response.status() }); crewFinished();
      });
    });
    // Last route wins: block forbidden calls before any mock could swallow them.
    await page.route("**/*", route => forbiddenWrite(new URL(route.request().url()), route.request().method())
      ? route.abort("blockedbyclient") : route.fallback());
    try {
      await page.goto(`/projects/${job.projectId}`);
      if (newDesign) await expect(page.getByRole("navigation", { name: "Main" }).getByText("Work", { exact: true })).toBeVisible();
      const testing = page.locator("section", { has: page.getByRole("heading", { name: "Testing", exact: true }) });
      const details = page.locator("section", { has: page.getByRole("heading", { name: /^(Edit )?job details$/i }) });
      await expect(testing).toBeVisible();
      const checkbox = testing.getByRole("checkbox", { name: /Testing project/ });
      await expect(checkbox).not.toBeChecked();
      const box = (await checkbox.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(24); expect(box.height).toBeLessThanOrEqual(24);
      expect((await testing.boundingBox())!.height).toBeLessThan(220);
      for (const card of [details, testing]) {
        const bounds = (await card.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => window.scrollTo(100, 600));
      expect(await page.evaluate(() => scrollX)).toBe(0); expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
      const tabs = page.locator(".hub-tabs");
      if (width < 500) {
        expect(await tabs.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
        await tabs.evaluate(el => { el.scrollLeft = el.scrollWidth; });
        expect(await tabs.evaluate(el => el.scrollLeft)).toBeGreaterThan(0); expect(await page.evaluate(() => scrollX)).toBe(0);
      }
      const navigationCount = state.navigations.length;
      page.on("dialog", dialog => dialog.dismiss());
      await page.getByRole("button", { name: "Finish this job…", exact: true }).click();
      await expect(page.getByRole("button", { name: "Cancel this job…", exact: true })).toBeVisible();
      await page.evaluate(() => (window as any).markJobEditEvidence("edit-action-start"));
      await details.getByRole("button", { name: "Edit", exact: true }).click();
      await page.evaluate(() => (window as any).markJobEditEvidence("edit-action-returned"));
      await expect(details.getByRole("heading", { name: "Edit job details" })).toBeVisible();
      expect(await details.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      const draftContact = "Unsubmitted diagnostic contact", draftNotes = "Unsubmitted diagnostic notes";
      await details.getByLabel("Customer / contact", { exact: true }).fill(draftContact);
      await details.locator("textarea").fill(draftNotes);
      await page.evaluate(() => (window as any).markJobEditEvidence("draft-entered"));
      const configuration = page.locator(".work-job-configuration");
      await expect(configuration.getByRole("heading", { name: "Work menu and job permissions", exact: true })).toBeVisible();
      if (mode !== "natural-instrumented") {
        await expect(configuration.getByText("Loading job menu…", { exact: true })).toBeVisible();
        await expect(page.getByText("Loading crew hours…", { exact: true })).toBeVisible();
        await page.evaluate(() => (window as any).markJobEditEvidence("artificial-data-release-with-draft"));
      }
      releaseData();
      // These are state/response/locator waits after a draft is entered, never
      // timed delays inserted to make the original Edit click pass.
      await crewResponseFinished;
      await expect(page.getByText("Loading crew hours…", { exact: true })).toHaveCount(0);
      await expect(configuration.getByText("Loading job menu…", { exact: true })).toHaveCount(0);
      await expect(configuration.getByRole("alert").filter({ hasText: "Menu choices are unavailable." })).toBeVisible();
      await expect(configuration.getByRole("alert").filter({ hasText: "Permissions are unavailable." })).toBeVisible();
      await page.evaluate(() => (window as any).markJobEditEvidence("both-cards-settled"));
      await expect(details.getByRole("heading", { name: "Edit job details" })).toBeVisible();
      await expect(details.getByLabel("Customer / contact", { exact: true })).toHaveValue(draftContact);
      await expect(details.locator("textarea")).toHaveValue(draftNotes);
      await details.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(details.getByRole("heading", { name: "Job details", exact: true })).toBeVisible();
      await expect(details).toContainText(project.customer_name); await expect(details).toContainText(project.contact_email); await expect(details).toContainText(project.notes);
      await expect(details).not.toContainText(draftContact); await expect(details).not.toContainText(draftNotes);
      expect(state.forbiddenWrites).toEqual([]);
      expect(state.navigations.length, "No route replacement/reload during the interaction and draft").toBe(navigationCount);
    } finally {
      releaseData(); // release held fixture reads on failure so teardown can finish
    }
  });
}

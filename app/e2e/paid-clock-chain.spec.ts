import { expect, test as base, webkit, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_AUTH_KEY, FIXTURE_SESSION, TEST_USER } from "./support/supabaseFixtures";
import { json } from "./support/specHelpers";
import type { PaidClockRecord } from "../src/lib/paidClock/storage";
import type { PaidClockPolicy } from "../src/lib/paidClock/dispatch";
// Linux WebKit's transient profile cannot prepare IndexedDB Blob storage.
// Use the same persistent-profile fixture as work-capture-journal.spec.ts;
// this preserves the real old-outbox Blob and byte-for-byte assertions.
const test = base.extend({
  context: async ({ browserName, context: inherited }, use) => {
    if (browserName !== "webkit") { await use(inherited); return; }
    const directory=mkdtempSync(join(tmpdir(),"paid-clock-webkit-"));
    let persistent;
    try {
      persistent=await webkit.launchPersistentContext(directory,{headless:true,viewport:{width:390,height:844},deviceScaleFactor:2});
      await use(persistent);
    } finally { try { await persistent?.close(); } finally { rmSync(directory,{recursive:true,force:true}); } }
  },
});
const OWNER = TEST_USER.id, DEVICE = "00000000-0000-4000-8000-000000000401", SHIFT = "00000000-0000-4000-8000-000000000402";
async function open(page: Page, withStatus=false) {
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: FIXTURE_AUTH_KEY, session: FIXTURE_SESSION });
  await page.route("**/*", route => new URL(route.request().url()).hostname === "localhost" ? route.continue() : route.abort());
  await page.route("**/paid-clock-chain-fixture", route => route.fulfill({ status: 200, contentType: "text/html", body:
    "<!doctype html><title>Native paid clock chain fixture</title><p>Native paid clock chain fixture</p>" }));
  // Let Vite transform the React fixture HTML and install its refresh preamble.
  await page.goto(withStatus?"/e2e/support/paid-clock-status.html":"/paid-clock-chain-fixture");
  await page.evaluate(async owner => {
    // @ts-expect-error Vite resolves browser module paths.
    const auth = await import("/src/lib/signedIn.ts"); auth.rememberSignedIn({ user: { id: owner } });
  }, OWNER);
}
test("separate native clock storage serializes current tabs, survives reload and cannot be consumed by the old outbox", async ({ page, context }) => {
  await open(page); const other = await context.newPage(); await open(other);
  const oldBytes = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("wops-write-outbox", 2);
      r.onupgradeneeded = () => { r.result.createObjectStore("entries", { keyPath: "id" }); r.result.createObjectStore("metadata", { keyPath: "id" }); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction("entries", "readwrite");
    tx.objectStore("entries").put({ id: "old-queued-clock", meta: "original-old-clock-payload", blob: new Blob([new Uint8Array([3, 7, 11])]) });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close(); return [3, 7, 11];
  });
  const append = (tab: Page, clientId: string) => tab.evaluate(async ({ device, clientId }) => {
    // @ts-expect-error Vite resolves browser module paths.
    const s = await import("/src/lib/paidClock/storage.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts");
    try { return { ok: true, row: await s.appendPaidClockIntent(a.signInMark(), device, { action: "clock_in", clientId,
      tappedAt: "2026-10-04T08:00:00.000Z", clockCheckedAt: null, clockSkewMs: null,
      projectId: null, costCodeId: null, photo: null, lat: null, lng: null, note: "Original tap", mode: null, setupVersion: 1 }, null) }; }
    catch { return { ok: false, row: null }; }
  }, { device: DEVICE, clientId });
  const ids = ["00000000-0000-4000-8000-000000000411", "00000000-0000-4000-8000-000000000412"];
  const raced = await Promise.all([append(page, ids[0]), append(other, ids[1])]);
  expect(raced.filter(row => row.ok)).toHaveLength(1);
  const original = raced.find(row => row.ok)!.row;
  await page.reload();
  const result = await page.evaluate(async owner => {
    // @ts-expect-error Vite resolves browser module paths.
    const s = await import("/src/lib/paidClock/storage.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts"); a.rememberSignedIn({ user: { id: owner } });
    const rows = await s.readPaidClockRecords(a.signInMark());
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("wops-write-outbox"); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction("entries"), entry = await new Promise<{ meta: string; blob: Blob }>(resolve => { const r = tx.objectStore("entries").get("old-queued-clock"); r.onsuccess = () => resolve(r.result); });
    const old = { version: db.version, stores: Array.from(db.objectStoreNames), meta: entry.meta, bytes: Array.from(new Uint8Array(await entry.blob.arrayBuffer())) };
    db.close(); return { rows, old };
  }, OWNER);
  expect(result.rows).toEqual([original]);
  expect(result.old).toEqual({ version: 2, stores: ["entries", "metadata"], meta: "original-old-clock-payload", bytes: oldBytes });
  expect((await append(page, original.clientId)).row).toEqual(original);
});

test("native causal appends abort on auth ABA and cannot turn an unknown delivery into a refusal", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async ({ device, owner, shift }) => {
    // @ts-expect-error Vite resolves browser module paths.
    const s = await import("/src/lib/paidClock/storage.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts");
    const id = crypto.randomUUID(), stamp = { tappedAt: "2026-10-04T08:00:00.000Z", clockCheckedAt: null, clockSkewMs: null };
    const clock = await s.appendPaidClockIntent(a.signInMark(), device, { ...stamp, action: "clock_in", clientId: id,
      projectId: null, costCodeId: null, photo: null, lat: null, lng: null, note: null, mode: null, setupVersion: 1 }, null);
    const add = IDBObjectStore.prototype.add; let injected = false;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      const request = add.apply(this, args);
      if (this.name === "requests" && !injected) { injected = true; a.rememberSignedIn(null); a.rememberSignedIn({ user: { id: owner } }); }
      return request;
    };
    let aborted = false;
    try { await s.appendPaidClockIntent(a.signInMark(), device, { ...stamp, action: "break_start", clientId: crypto.randomUUID(),
      shiftRef: { kind: "clock_command", id }, breakType: "rest" }, id); } catch { aborted = true; }
    finally { IDBObjectStore.prototype.add = add; }
    const afterAbort = await s.readPaidClockRecords(a.signInMark()), token = crypto.randomUUID();
    await s.updatePaidClockDelivery(a.signInMark(), id, null, (row: PaidClockRecord) => ({ ...row.delivery, status: "sending", attemptToken: token, everAttempted: true }));
    await s.updatePaidClockDelivery(a.signInMark(), id, token, (row: PaidClockRecord) => ({ ...row.delivery, status: "uncertain", everUncertain: true }));
    let refusalBlocked = false;
    try { await s.updatePaidClockDelivery(a.signInMark(), id, token, (row: PaidClockRecord) => ({ ...row.delivery, status: "attention", attentionReason: "late_sql_refusal" })); } catch { refusalBlocked = true; }
    const receipt = { clientId: id, action: "clock_in", outcome: "clocked_in", shiftId: shift, ...stamp,
      arrivedAt: "2026-10-04T08:00:01.000000Z", usedTapTime: true, reviewReason: null,
      receiptProtocol: "setup_v1", retention: "retained", sourcePresent: true, activityTransition: null };
    await s.updatePaidClockDelivery(a.signInMark(), id, token, (row: PaidClockRecord) => ({ ...row.delivery, status: "acknowledged", resolvedShiftId: shift, receipt }));
    const settled = await s.readPaidClockRecords(a.signInMark());
    a.rememberSignedIn({ user: { id: "00000000-0000-4000-8000-000000000499" } });
    const foreign = await s.readPaidClockRecords(a.signInMark());
    return { aborted, afterAbort, clock, refusalBlocked, settled, foreign };
  }, { device: DEVICE, owner: OWNER, shift: SHIFT });
  expect(result.aborted).toBe(true); expect(result.afterAbort).toEqual([result.clock]);
  expect(result.refusalBlocked).toBe(true); expect(result.foreign).toEqual([]);
  expect(result.settled[0].delivery).toMatchObject({ status: "acknowledged", everUncertain: true });
  expect(result.settled[0].intent).toEqual(result.clock.intent);
});

test("fresh explicit self-owned safety origin preserves an unresolved setup chain", async ({ page }) => {
  await open(page);
  await page.route("**/rest/v1/time_shifts?**", route => {
    const q = new URL(route.request().url()).searchParams;
    expect(q.get("id")).toBe(`eq.${SHIFT}`); expect(q.get("profile_id")).toBe(`eq.${OWNER}`);
    return json(route, { id: SHIFT, profile_id: OWNER, status: "open", clock_out_at: null }, null);
  });
  const result = await page.evaluate(async ({ owner, device, shift }) => {
    // @ts-expect-error Vite resolves browser module paths.
    const s = await import("/src/lib/paidClock/storage.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const api = await import("/src/lib/paidClock/api.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts");
    const stamp = { tappedAt: "2026-10-04T08:00:00.000Z", clockCheckedAt: null, clockSkewMs: null }, id = crypto.randomUUID();
    const clock = await s.appendPaidClockIntent(a.signInMark(), device, { ...stamp, action: "clock_in", clientId: id,
      projectId: null, costCodeId: null, photo: null, lat: null, lng: null, note: null, mode: null, setupVersion: 1 }, null);
    const token = crypto.randomUUID();
    await s.updatePaidClockDelivery(a.signInMark(), id, null, (row: PaidClockRecord) => ({ ...row.delivery, status: "sending", everAttempted: true, attemptToken: token }));
    await s.updatePaidClockDelivery(a.signInMark(), id, token, (row: PaidClockRecord) => ({ ...row.delivery, status: "uncertain", everUncertain: true }));
    const out = { ...stamp, action: "clock_out" as const, clientId: crypto.randomUUID(), shiftRef: { kind: "shift" as const, id: shift },
      photo: null, injured: false, timeConfirmed: false, breakSeconds: 0, lat: null, lng: null, injuryNote: null };
    let fakeRefused = false;
    try { await s.appendPaidClockIntent(a.signInMark(), device, out, null, { ownerId: owner, shiftId: shift, loginGeneration: a.signInMark().generation }); } catch { fakeRefused = true; }
    const basis = await api.fetchOwnClockSafetyBasis(shift, a.signInMark());
    const safety = await s.appendPaidClockIntent(a.signInMark(), device, out, null, basis);
    return { fakeRefused, clock, safety, rows: await s.readPaidClockRecords(a.signInMark()) };
  }, { owner: OWNER, device: DEVICE, shift: SHIFT });
  expect(result.fakeRefused).toBe(true); expect(result.rows).toHaveLength(2);
  expect(result.safety.origin).toEqual({ kind: "shift", id: SHIFT });
  expect(result.safety.predecessorClientId).toBeNull();
  expect(result.safety.storageGeneration).not.toBe(result.clock.storageGeneration);
  expect(result.rows.find((row: PaidClockRecord) => row.clientId === result.clock.clientId)?.delivery.status).toBe("uncertain");
});

test("native dispatch locks retain the original unknown punch through a refusal until its exact receipt arrives", async ({ page, context }) => {
  await open(page); const other = await context.newPage(); await open(other);
  const id = "00000000-0000-4000-8000-000000000451", child = "00000000-0000-4000-8000-000000000452";
  const end = "00000000-0000-4000-8000-000000000453";
  const calls: Array<{ rpc: string; args: Record<string, unknown>; durable: boolean }> = [];
  let receiptReady = false, refusal = false, release!: () => void;
  const barrier = new Promise<void>(done => { release = done; });
  for (const tab of [page, other]) await tab.route("**/rest/v1/rpc/*", async route => {
    const rpc = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() as Record<string, unknown>;
    if (rpc === "work_activity_clock_receipt") return json(route, receiptReady && args.p_client_id === id ? {
      protocolVersion: 1, availability: "available", receipt: { clientId: id, action: "clock_in", outcome: "clocked_in", shiftId: SHIFT,
        tappedAt: "2026-10-04T08:00:00.000Z", arrivedAt: "2026-10-04T08:00:01Z", clockCheckedAt: null, clockSkewMs: null,
        usedTapTime: true, reviewReason: null, receiptProtocol: "setup_v1", retention: "retained", sourcePresent: true, activityTransition: null },
    } : { protocolVersion: 1, availability: "unavailable", receipt: null }, null);
    const durable = await tab.evaluate(async clientId => {
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open("iw-paid-clock-chain-v1", 1); r.onsuccess = () => resolve(r.result); });
      const tx = db.transaction("requests"), row = await new Promise<PaidClockRecord>(resolve => {
        const r = tx.objectStore("requests").get(clientId); r.onsuccess = () => resolve(r.result);
      }); db.close(); return row?.delivery.status === "sending" && row.delivery.everAttempted && !!row.delivery.attemptToken;
    }, String(args.p_client_id));
    calls.push({ rpc, args, durable });
    if (rpc === "clock_in" && !refusal) { await barrier; return route.abort("failed"); }
    if (rpc === "clock_in") return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "42501", message: "Synthetic refusal after unknown" }) });
    if (rpc === "start_break") return json(route, { id: SHIFT, status: "open" }, null); // mutable reply cannot acknowledge delivery
    throw new Error(`Unexpected native clock RPC ${rpc}`);
  });
  await page.evaluate(async ({ device, id, child, end }) => {
    // @ts-expect-error Vite resolves browser module paths.
    const s = await import("/src/lib/paidClock/storage.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts");
    const evidence = { tappedAt: "2026-10-04T08:00:00.000Z", clockCheckedAt: null, clockSkewMs: null };
    await s.appendPaidClockIntent(a.signInMark(), device, { ...evidence, action: "clock_in", clientId: id, projectId: null, costCodeId: null,
      photo: null, lat: null, lng: null, note: "Original native tap", mode: null, setupVersion: 1 }, null);
    await s.appendPaidClockIntent(a.signInMark(), device, { ...evidence, action: "break_start", clientId: child, shiftRef: { kind: "clock_command", id }, breakType: "rest" }, id);
    await s.appendPaidClockIntent(a.signInMark(), device, { ...evidence, action: "break_end", clientId: end, shiftRef: { kind: "clock_command", id } }, child);
  }, { device: DEVICE, id, child, end });
  const dispatch = (tab: Page, clientId: string, policy: PaidClockPolicy) => tab.evaluate(async ({ clientId, policy }) => {
    // @ts-expect-error Vite resolves browser module paths.
    const d = await import("/src/lib/paidClock/dispatch.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts");
    return d.dispatchPaidClockRequest(clientId, a.signInMark(), policy);
  }, { clientId, policy });
  expect(await dispatch(page, child, "first_attempt")).toEqual({ kind: "held", reason: "dependency" });
  const first = dispatch(page, id, "first_attempt");
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].durable).toBe(true);
  expect(await dispatch(other, id, "first_attempt")).toEqual({ kind: "held", reason: "dispatcher_busy" });
  release(); expect(await first).toEqual({ kind: "held", reason: "unknown" });
  await page.reload();
  await page.evaluate(async owner => {
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts"); a.rememberSignedIn({ user: { id: owner } });
  }, OWNER);
  expect(await dispatch(page, id, "first_attempt")).toEqual({ kind: "held", reason: "unknown" });
  expect(calls).toHaveLength(1); // same-owner restart never resends an unknown automatically
  refusal = true;
  expect(await dispatch(page, id, "retry_original")).toEqual({ kind: "held", reason: "unknown" });
  expect(calls).toHaveLength(2); expect(calls[1].args).toEqual(calls[0].args);
  expect(Object.keys(calls[0].args)).toHaveLength(12); expect(calls[0].args.p_setup_version).toBe(1);
  receiptReady = true;
  const settled = await dispatch(page, id, "check_only");
  expect(settled).toMatchObject({ kind: "settled", record: { clientId: id, delivery: { status: "acknowledged", everUncertain: true, resolvedShiftId: SHIFT } } });
  expect(calls).toHaveLength(2);
  expect(await dispatch(page, child, "first_attempt")).toEqual({ kind: "held", reason: "unknown" });
  expect(calls[2]).toMatchObject({ rpc: "start_break", durable: true, args: { p_shift_id: SHIFT, p_client_id: child, p_break_type: "rest" } });
  expect(await dispatch(page, end, "first_attempt")).toEqual({ kind: "held", reason: "dependency" });
  expect(calls).toHaveLength(3);
});

test("a fresh removed-source receipt holds an explicit-shift descendant and preserves the historical acknowledgement", async ({ page }) => {
  await open(page);
  const start = "00000000-0000-4000-8000-000000000461", end = "00000000-0000-4000-8000-000000000462";
  const historical = { clientId: start, action: "break_start", outcome: "started", shiftId: SHIFT,
    tappedAt: "2026-10-04T08:00:00.000Z", arrivedAt: "2026-10-04T08:00:01Z", clockCheckedAt: null, clockSkewMs: null,
    usedTapTime: true, reviewReason: null, receiptProtocol: "legacy", retention: "retained", sourcePresent: true, activityTransition: null };
  await page.route("**/rest/v1/time_shifts?**", route => json(route, { id: SHIFT, profile_id: OWNER, status: "open", clock_out_at: null }, null));
  const reads: unknown[] = [];
  await page.route("**/rest/v1/rpc/*", route => {
    expect(new URL(route.request().url()).pathname.split("/").at(-1)).toBe("work_activity_clock_receipt");
    reads.push(route.request().postDataJSON());
    return json(route, { protocolVersion: 1, availability: "available", receipt: { ...historical, sourcePresent: false } }, null);
  });
  await page.evaluate(async ({ start, end, device, shift, historical }) => {
    // @ts-expect-error Vite resolves browser module paths.
    const s = await import("/src/lib/paidClock/storage.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const api = await import("/src/lib/paidClock/api.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts");
    const evidence = { tappedAt: "2026-10-04T08:00:00.000Z", clockCheckedAt: null, clockSkewMs: null };
    const basis = await api.fetchOwnClockSafetyBasis(shift, a.signInMark());
    await s.appendPaidClockIntent(a.signInMark(), device, { ...evidence, action: "break_start", clientId: start,
      shiftRef: { kind: "shift", id: shift }, breakType: "rest" }, null, basis);
    const token=crypto.randomUUID();
    await s.updatePaidClockDelivery(a.signInMark(), start, null, (row: PaidClockRecord) => ({ ...row.delivery,
      status:"sending",attemptToken:token,everAttempted:true,resolvedShiftId:shift }));
    await s.updatePaidClockDelivery(a.signInMark(), start, token, (row: PaidClockRecord) => ({ ...row.delivery,
      status:"acknowledged",receipt:historical }));
    await s.appendPaidClockIntent(a.signInMark(), device, { ...evidence, action:"break_end", clientId:end, shiftRef:{kind:"shift",id:shift} }, start);
  }, { start, end, device: DEVICE, shift: SHIFT, historical });
  await page.reload();
  const result = await page.evaluate(async ({ owner, end }) => {
    // @ts-expect-error Vite resolves browser module paths.
    const s = await import("/src/lib/paidClock/storage.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const d = await import("/src/lib/paidClock/dispatch.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const a = await import("/src/lib/signedIn.ts"); a.rememberSignedIn({user:{id:owner}});
    return { outcome:await d.dispatchPaidClockRequest(end,a.signInMark(),"first_attempt"),rows:await s.readPaidClockRecords(a.signInMark()) };
  }, { owner:OWNER,end });
  expect(result.outcome).toEqual({kind:"held",reason:"attention"});
  expect(reads).toEqual([{p_client_id:start}]); // no end_break call against the removed source
  expect(result.rows.find((r:PaidClockRecord)=>r.clientId===start)?.delivery.receipt).toEqual(historical);
  expect(result.rows.find((r:PaidClockRecord)=>r.clientId===end)?.delivery).toMatchObject({status:"attention",attentionReason:"source_removed",everAttempted:false});
});

test("the recovery view wakes current tabs, preserves an unknown original and never claims a current shift from delivery history", async ({ page, context }) => {
  await open(page,true); const other=await context.newPage(); await open(other,true);
  await expect(page.getByRole("button",{name:"Remount reader"})).toBeVisible();
  await expect(other.getByRole("button",{name:"Remount reader"})).toBeVisible();
  const clientId="00000000-0000-4000-8000-000000000471", calls:Record<string,unknown>[]=[];
  const stamp={clientId,tappedAt:"2026-10-04T08:00:00.123456-06:00",clockCheckedAt:null,clockSkewMs:null};
  let receiptReady=false;
  await other.evaluate(()=>{
    const channel=new BroadcastChannel("forge-paid-clock-chain-wake-v1");
    const observed:unknown[]=[]; channel.onmessage=event=>observed.push(event.data);
    (window as Window & {paidWakeMessages?:unknown[]}).paidWakeMessages=observed;
  });
  await page.route("**/rest/v1/rpc/*",route=>{
    const rpc=new URL(route.request().url()).pathname.split("/").at(-1);
    if(rpc==="work_activity_clock_receipt") return json(route,receiptReady?{
      protocolVersion:1,availability:"available",receipt:{...stamp,action:"clock_in",outcome:"clocked_in",shiftId:SHIFT,
        arrivedAt:"2026-10-04T14:30:01Z",usedTapTime:true,reviewReason:null,receiptProtocol:"setup_v1",retention:"retained",sourcePresent:true,activityTransition:null},
    }:{protocolVersion:1,availability:"unavailable",receipt:null},null);
    expect(rpc).toBe("clock_in");calls.push(route.request().postDataJSON());
    return calls.length===1?route.abort("failed"):route.fulfill({status:403,contentType:"application/json",body:JSON.stringify({code:"42501",message:"fixture first reply was unknown"})});
  });
  const submitted=await page.evaluate(async original=>{
    // @ts-expect-error Vite resolves browser module paths.
    const c=await import("/src/lib/paidClock/coordinator.ts");
    // @ts-expect-error Vite resolves browser module paths.
    const auth=await import("/src/lib/signedIn.ts");
    return c.submitPaidClockIntent(auth.signInMark(),c.paidSetupIntent(original),null);
  },stamp);
  expect(submitted).toEqual({kind:"saved",clientId,dispatch:{kind:"held",reason:"unknown"}});
  for(const tab of [page,other]) await expect(tab.getByText("Confirmation pending · Forge may already have received this punch",{exact:true})).toBeVisible();
  const wakeMessages=await other.evaluate(()=>(window as Window & {paidWakeMessages?:unknown[]}).paidWakeMessages);
  expect(wakeMessages!.length).toBeGreaterThan(0);expect(wakeMessages!.every(value=>value===null)).toBe(true);
  expect(calls).toHaveLength(1);
  await page.getByRole("button",{name:"Check confirmation",exact:true}).click();
  await expect(page.getByText("No new confirmation was found.",{exact:false})).toBeVisible();expect(calls).toHaveLength(1);
  await page.getByRole("button",{name:"Resend original punch",exact:true}).click();
  await expect.poll(()=>calls.length).toBe(2);expect(calls[1]).toEqual(calls[0]);
  expect(calls[0].p_tapped_at).toBe(stamp.tappedAt);expect(calls[0].p_client_id).toBe(clientId);expect(Object.keys(calls[0])).toHaveLength(12);
  await context.setOffline(true);
  await expect(page.getByRole("button",{name:"Resend original punch",exact:true})).toBeDisabled();
  for(const language of ["en","es"]){
    if(language==="es") await page.getByRole("button",{name:"EN / ES"}).click();
    for(const viewport of [{width:320,height:844},{width:390,height:844},{width:844,height:390}]){
      await page.setViewportSize(viewport);
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
      expect(await page.locator(".paid-clock-actions button").evaluateAll(buttons=>buttons.every(button=>button.getBoundingClientRect().height>=44))).toBe(true);
      if(viewport.width===320) await page.screenshot({path:`e2e/__screenshots__/paid-clock-recovery-${language}-320.png`,fullPage:true});
    }
  }
  await page.getByRole("button",{name:"Remount reader"}).click();
  await expect(page.getByText("Confirmación pendiente · Forge puede haber recibido esta marcación",{exact:true})).toBeVisible();expect(calls).toHaveLength(2);
  await context.setOffline(false);await page.getByRole("button",{name:"EN / ES"}).click();
  await page.reload();await expect(page.getByText("Confirmation pending · Forge may already have received this punch",{exact:true})).toBeVisible();expect(calls).toHaveLength(2);
  receiptReady=true;await page.getByRole("button",{name:"Check confirmation",exact:true}).click();
  for(const tab of [page,other]) await expect(tab.getByText("Delivery confirmed · historical receipt",{exact:true})).toBeVisible();
  await expect(page.getByText("A receipt confirms delivery of that punch.",{exact:false})).toBeVisible();
  await expect(page.getByText("Start-of-day setup",{exact:false})).toHaveCount(0);expect(calls).toHaveLength(2);
  await page.getByRole("button",{name:"Logout fixture"}).click();await expect(page.locator("[data-clock-request]")).toHaveCount(0);
  await page.getByRole("button",{name:"Login fixture"}).click();await expect(page.getByText("Delivery confirmed · historical receipt",{exact:true})).toBeVisible();expect(calls).toHaveLength(2);
});

// Offline toolbox signing (owner go, 2026-09-25). The owner hit it in the
// field: a toolbox talk could not be signed with no signal — and without
// today's signature the server refuses the day's first clock-in, so nobody
// could clock in either.
//
// Proved against the real app, the way a phone does it, on a 375 px phone and
// in a desktop window:
//   1. with no signal, today's talk signs: the sheet says "Signed — waiting to
//      send" at once and Clock in unlocks; the clock-in is saved on the phone
//      behind the signature;
//   2. a reload with no signal keeps both on the phone, and the gate stays
//      open: the clock is on, Safety says the talk is signed and waiting to
//      send and offers no second signature, Stuck writes lists both, and the
//      sync pill counts both;
//   3. when signal returns the server receives EXACTLY one completion and
//      then exactly one clock_in, in that order; the files went where the
//      row says, made from the signature's own id; and the punch is paid
//      from the tap made in the dead zone, not from when it arrived;
//   4. a signature the server refuses keeps the clock-in on the phone,
//      unsent, both are said honestly, and Try again sends both, in order.
//
// The talk carries Do and Don't lists and a check mark in its words (the
// coordinator's ask, 2026-09-25): the PDF's standard fonts cannot draw every
// character a talk can hold, and a signature must never depend on that.
//
// The dead zone is made the way queued-clock.spec.ts makes it: every Supabase
// call is refused outright while the signal is off, the app's own files pass
// through route.fetch() so a reload works offline, and the refusals are
// counted so a run where the app quietly reached the server cannot pass.

import { expect, test, type Page } from "@playwright/test";
import { TEST_USER, useSupabaseFixtures } from "./support/supabaseFixtures";
import { dayISO, hideWrongProjectBanner, json, stubGeolocationDenied } from "./support/specHelpers";

const BLACK22 = "ebf64f94-0413-4434-aeb3-1aff228fb5b3";
const GENERAL = "11111111-aaaa-4aaa-8aaa-111111111111";
const TALK_ID = "33333333-cccc-4ccc-8ccc-333333333399";

const COST_CODES = [
  { id: GENERAL, code: "000", label: "General", description: null, active: true, sort_order: 5, is_general: true },
];

const TALK = {
  id: TALK_ID,
  title: "Glass handling ✓",
  body: "Carry glass on edge ✓ — never flat.",
  talk_date: dayISO(0),
  sections_json: {
    intro: "Carry glass on edge ✓ never flat.",
    key_hazards: ["Edge cuts"],
    dos: ["Wear cut sleeves ✓", "Two people over 4 ft"],
    donts: ["Don't carry it flat ✗", "Don't lift with wet gloves"],
  },
  key_points: ["Glass on edge ✓", "Sleeves on"],
  watch_for: ["Chipped edges"],
  stop_work_line: "A cracked lite is a stop-work.",
  pledge: null,
  created_at: `${dayISO(0)}T06:00:00Z`,
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** Yesterday's punch, so the landing primes itself with BLACK22 + General. */
const RECENT_SHIFTS = [
  { project_id: BLACK22, cost_code_id: GENERAL, clock_in_at: hoursAgo(26), projects: { job_code: "BLACK22", name: "Black Desert" } },
];

type Row = Record<string, unknown>;

/** The signal switch, and the count of calls refused while it was off. */
class Signal {
  dead = false;
  refused = 0;
}

/** Everything that reached the server, in the order it arrived. */
interface Server {
  writes: string[];
  signs: Row[];
  clockIns: Row[];
  uploads: { path: string; type: string }[];
  /** Refuse the next signatures, the way sign_toolbox_talk refuses someone else's. */
  refuseSign: boolean;
}

const REFUSAL = "This toolbox talk signature belongs to someone else on this phone. Sign in as the person who signed it to send it.";

async function fieldServer(page: Page, signal: Signal): Promise<Server> {
  const server: Server = { writes: [], signs: [], clockIns: [], uploads: [], refuseSign: false };
  let signed: Row | null = null;
  let openShift: Row | null = null;

  // Today's talk exists; any date asked for gets it (the phone also reads the
  // next three days ahead).
  await page.route("**/rest/v1/safety_talks**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    return accept.includes("pgrst.object") ? json(r, TALK, 1) : json(r, [TALK], 1);
  });
  // "Did I sign today?" — no, until Forge has filed a signature.
  await page.route("**/rest/v1/toolbox_completions**", (r) => {
    const accept = r.request().headers()["accept"] ?? "";
    if (accept.includes("pgrst.object")) return json(r, signed, signed ? 1 : 0);
    return json(r, signed ? [signed] : [], signed ? 1 : 0);
  });
  await page.route("**/rest/v1/cost_codes**", (r) => json(r, COST_CODES, COST_CODES.length));
  await page.route("**/rest/v1/project_cost_codes**", (r) => json(r, [], 0));
  // The open-shift lookup and the recent-jobs list share a table; the status
  // filter tells them apart (see clock-in-once.spec.ts).
  await page.route("**/rest/v1/time_shifts**", (r) => {
    const url = new URL(r.request().url());
    if ((url.searchParams.get("status") ?? "").startsWith("in.")) {
      return json(r, openShift ? [openShift] : [], openShift ? 1 : 0);
    }
    return json(r, RECENT_SHIFTS, RECENT_SHIFTS.length);
  });
  await page.route((url) => /\/rest\/v1\/rpc\/server_now(\?|$)/.test(url.href), (r) =>
    json(r, new Date().toISOString(), null),
  );
  await page.route((url) => /\/rest\/v1\/rpc\/get_or_create_toolbox_talk_for_date(\?|$)/.test(url.href), (r) =>
    json(r, TALK, null),
  );
  // The signature's files: recorded, so the test can match them to the row.
  await page.route("**/storage/v1/object/toolbox-records/**", (r) => {
    const url = new URL(r.request().url());
    const path = decodeURIComponent(url.pathname.split("/storage/v1/object/toolbox-records/")[1] ?? "");
    server.uploads.push({ path, type: r.request().headers()["content-type"] ?? "" });
    server.writes.push("upload");
    return json(r, { Key: `toolbox-records/${path}` }, null);
  });
  // The one way the app files a signature now.
  await page.route((url) => /\/rest\/v1\/rpc\/sign_toolbox_talk(\?|$)/.test(url.href), (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Row;
    server.signs.push(body);
    server.writes.push("sign_toolbox_talk");
    if (server.refuseSign) {
      return r.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ code: "42501", message: REFUSAL, details: null, hint: null }),
      });
    }
    signed = {
      id: "44444444-dddd-4ddd-8ddd-444444444499",
      talk_id: body.p_talk_id ?? null,
      profile_id: body.p_profile_id ?? null,
      client_id: body.p_client_id ?? null,
      typed_name: body.p_typed_name ?? null,
      signature_path: body.p_signature_path ?? null,
      pdf_path: body.p_pdf_path ?? null,
      talk_snapshot: body.p_talk_snapshot ?? null,
      signed_at: body.p_signed_at ?? new Date().toISOString(),
      signed_via: "self",
      created_at: new Date().toISOString(),
    };
    return json(r, signed, null);
  });
  await page.route((url) => /\/rest\/v1\/rpc\/clock_in(\?|$)/.test(url.href), (r) => {
    const body = (r.request().postDataJSON() ?? {}) as Row;
    server.clockIns.push(body);
    server.writes.push("clock_in");
    const at = (body.p_tapped_at as string | null) ?? new Date().toISOString();
    openShift = {
      id: "55555555-eeee-4eee-8eee-555555555599",
      profile_id: TEST_USER.id,
      project_id: body.p_project_id ?? null,
      cost_code_id: body.p_cost_code_id ?? null,
      clock_in_at: at,
      clock_out_at: null,
      break_seconds: 0,
      break_started_at: null,
      break_type: null,
      injured: null,
      time_confirmed: null,
      status: "open",
      created_at: at,
      note: body.p_note ?? null,
      client_id: body.p_client_id ?? null,
      clocked_in_by: null,
      clocked_out_by: null,
      projects: { job_code: "BLACK22", name: "Black Desert" },
      cost_codes: { code: "000", label: "General" },
      profiles: { display_name: "E2E Fixture" },
      editor: null,
      voider: null,
    };
    return json(r, openShift, null);
  });

  // The dead zone, registered last so it wins while the signal is off.
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.host.startsWith("localhost")) {
      if (!signal.dead) return route.fallback();
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch {
        await route.abort();
      }
      return;
    }
    if (signal.dead && /\/(rest|storage|functions)\/v1\//.test(url.pathname)) {
      signal.refused += 1;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });

  return server;
}

async function noSignal(page: Page, signal: Signal) {
  signal.dead = true;
  await page.context().setOffline(true);
}

/** Signal comes back: the browser's own `online` event is what wakes the outbox. */
async function signalReturns(page: Page, signal: Signal) {
  signal.dead = false;
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

/** Pledge, typed name, one drawn stroke — then Sign. */
async function signTheTalk(page: Page, scope: ReturnType<Page["locator"]>) {
  await scope.getByText("I read and understood today's talk").click();
  await scope.getByPlaceholder("Full name").fill("E2E Fixture");
  const pad = scope.locator("canvas.sig-canvas");
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2 + 10, { steps: 8 });
  await page.mouse.up();
  const sign = scope.getByRole("button", { name: "Sign today's talk" });
  await expect(sign).toBeEnabled();
  await sign.click();
}

async function setUp(page: Page) {
  await useSupabaseFixtures(page, { role: "installer" });
  await hideWrongProjectBanner(page);
  await stubGeolocationDenied(page);
  const signal = new Signal();
  const server = await fieldServer(page, signal);
  return { signal, server };
}

for (const [where, viewport] of [
  ["on a 375 px phone", { width: 375, height: 812 }],
  ["in a desktop window", { width: 1280, height: 860 }],
] as const) {
  test.describe(where, () => {
    test.use({ viewport });

    test("signs with no signal, clocks in behind the signature, survives a reload, and the server hears one signature then one clock-in", async ({
      page,
    }) => {
      const { signal, server } = await setUp(page);
      await page.goto("/");
      const block = page.locator(".clockin-block");
      await expect(block).toBeVisible();
      await expect(block.locator(".clock-btn.primary.big")).toHaveText(/Sign safety talk & clock in/);

      await noSignal(page, signal);

      // The full clock sheet: today's talk, and a Start held until it is signed.
      await block.getByRole("button", { name: "More options — different job, break, sign the talk" }).click();
      const sheet = page.locator(".clock-sheet");
      await expect(sheet).toBeVisible();
      const start = sheet.locator(".clock-btn.primary.big");
      await expect(start).toBeDisabled();
      await expect(sheet.getByText("Sign today's toolbox talk above to clock in.")).toBeVisible();

      const signedFrom = Date.now();
      await signTheTalk(page, sheet);

      // Signed at once, with no signal — and saying it has not reached Forge.
      const status = sheet.locator(".toolbox-sign-status");
      await expect(status).toHaveAttribute("data-state", "pending");
      await expect(status).toContainText("Signed — waiting to send");
      await expect(sheet.locator("canvas.sig-canvas")).toHaveCount(0);
      // Clock in unlocked.
      await expect(start).toBeEnabled();
      const tappedFrom = Date.now();
      await start.click();

      // On the clock from the phone's own copy; nothing has left the phone.
      // (The nav's clock tab is drawn on a phone and kept, hidden, beside the
      // desktop rail — its presence is the answer on both.)
      const clockOn = page.locator(".tab.clock-on");
      await expect(clockOn).toHaveCount(1);
      expect(server.writes).toEqual([]);

      // A reload with no signal: both are still on the phone and the gate is
      // still open.
      await page.reload();
      await expect(clockOn).toHaveCount(1);
      await page.goto("/safety");
      const safetyStatus = page.locator(".toolbox-sign-status");
      await expect(safetyStatus).toHaveAttribute("data-state", "pending");
      await expect(safetyStatus).toContainText("Signed — waiting to send");
      await expect(page.getByRole("button", { name: "Sign & complete" })).toHaveCount(0);
      await page.goto("/stuck");
      const signRow = page.locator("li[data-state=waiting]", { hasText: "Toolbox talk signature" });
      const clockRow = page.locator("li[data-state=waiting]", { hasText: "Clock in" });
      await expect(signRow).toBeVisible();
      await expect(clockRow).toBeVisible();
      // The pill rides the header on a phone and the rail on a desktop.
      const pill = page.locator(".sync-pill").first();
      await expect(pill).toContainText("Clock 1");
      await expect(pill).toContainText("Toolbox talk 1");
      expect(server.writes).toEqual([]);
      expect(signal.refused, "nothing was refused — the app was never cut off").toBeGreaterThan(0);

      // Signal returns. Chromium starts every new document with
      // navigator.onLine true, whatever the offline emulation says, so after
      // the reload this phone behaved like one with bars and no data: it
      // tried the signature, failed, and backed off. No `online` event wakes
      // that — the outbox's own 30-second tick does, the way it does on a
      // real phone whose bars came back without the signal ever reading
      // "offline". So this waits for the tick, not for a tap.
      const backAt = Date.now();
      await signalReturns(page, signal);
      await expect.poll(() => server.clockIns.length, { timeout: 75_000 }).toBe(1);
      await page.waitForTimeout(1_500);

      // EXACTLY one completion, then exactly one clock_in, in that order.
      const order = server.writes.filter((w) => w !== "upload");
      expect(order).toEqual(["sign_toolbox_talk", "clock_in"]);
      expect(server.writes.lastIndexOf("upload")).toBeLessThan(server.writes.indexOf("sign_toolbox_talk"));
      const [sign] = server.signs;
      expect(sign.p_profile_id).toBe(TEST_USER.id);
      expect(sign.p_talk_id).toBe(TALK_ID);
      expect(sign.p_typed_name).toBe("E2E Fixture");
      // The files went where the row says, at paths made from the signature's id.
      expect(sign.p_signature_path).toBe(`${TEST_USER.id}/${TALK_ID}/${dayISO(0)}-${sign.p_client_id}-signature.png`);
      const uploaded = server.uploads.map((u) => u.path);
      expect(uploaded).toContain(sign.p_signature_path);
      if (sign.p_pdf_path !== null) {
        expect(sign.p_pdf_path).toBe(`${TEST_USER.id}/${TALK_ID}/${dayISO(0)}-${sign.p_client_id}.pdf`);
        expect(uploaded).toContain(sign.p_pdf_path);
      }
      // The talk exactly as it was signed, check marks and all.
      expect(String(sign.p_talk_snapshot)).toContain("Wear cut sleeves ✓");
      // Signed when it was signed, not when it arrived …
      const signedAt = Date.parse(String(sign.p_signed_at));
      expect(signedAt).toBeGreaterThanOrEqual(signedFrom - 1_000);
      expect(signedAt).toBeLessThan(backAt);
      // … and the punch paid from the tap in the dead zone, after the signature.
      const [punch] = server.clockIns;
      const tappedAt = Date.parse(String(punch.p_tapped_at));
      expect(tappedAt).toBeGreaterThanOrEqual(tappedFrom - 1_000);
      expect(tappedAt).toBeLessThan(backAt);
      expect(tappedAt).toBeGreaterThanOrEqual(signedAt);
      expect(punch.p_project_id).toBe(BLACK22);
      expect(punch.p_client_id).toEqual(expect.any(String));

      // Forge has both: nothing waits, and Safety says Signed.
      await expect(page.locator("li[data-state=waiting]", { hasText: "Toolbox talk signature" })).toHaveCount(0);
      await page.goto("/safety");
      await expect(page.getByText("Signed today ✓")).toBeVisible();
      expect(server.signs).toHaveLength(1);
      expect(server.clockIns).toHaveLength(1);
    });

    test("a signature the server refuses keeps the clock-in on the phone, says so, and Try again sends both in order", async ({
      page,
    }) => {
      const { signal, server } = await setUp(page);
      await page.goto("/");
      const block = page.locator(".clockin-block");
      await expect(block).toBeVisible();

      await noSignal(page, signal);

      // The landing's one tap: the talk opens in the block, and signing it IS
      // the clock-in.
      await block.locator(".clock-btn.primary.big").click();
      await expect(block.getByText("Today's toolbox talk")).toBeVisible();
      await signTheTalk(page, block);
      await expect(page.locator(".tab.clock-on")).toHaveCount(1);
      expect(server.writes).toEqual([]);

      // Signal returns, and Forge refuses the signature.
      server.refuseSign = true;
      await signalReturns(page, signal);
      await expect.poll(() => server.signs.length).toBe(1);
      await page.waitForTimeout(2_000);
      // Held, not sent: never refused on the toolbox gate.
      expect(server.clockIns).toHaveLength(0);

      await page.goto("/stuck");
      const refused = page.locator("li[data-state=failed]", { hasText: "Toolbox talk signature" });
      await expect(refused).toBeVisible();
      await expect(refused).toContainText("belongs to someone else");
      const held = page.locator("li[data-state=waiting]", { hasText: "Clock in" });
      await expect(held).toBeVisible();
      await expect(held).toContainText("Waiting for today's toolbox talk signature above");
      await expect(page.locator(".sync-pill").first()).toHaveAttribute("data-tone", "attention");
      expect(server.clockIns).toHaveLength(0);

      await page.goto("/safety");
      const status = page.locator(".toolbox-sign-status");
      await expect(status).toHaveAttribute("data-state", "refused");
      await expect(status).toContainText("belongs to someone else");
      await expect(status).toContainText("Your clock-in waits for it.");

      // Forge would take it now: Try again sends the signature, then the clock-in.
      server.refuseSign = false;
      await page.goto("/stuck");
      await page.locator("li[data-state=failed]", { hasText: "Toolbox talk signature" }).getByRole("button", { name: "Try again" }).click();
      await expect.poll(() => server.clockIns.length).toBe(1);
      expect(server.writes.filter((w) => w !== "upload")).toEqual(["sign_toolbox_talk", "sign_toolbox_talk", "clock_in"]);
      expect(server.signs[1].p_client_id).toBe(server.signs[0].p_client_id);
    });
  });
}

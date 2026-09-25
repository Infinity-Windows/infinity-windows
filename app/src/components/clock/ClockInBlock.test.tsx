// @vitest-environment happy-dom
//
// The one big clock-in spot, mounted for real and read from the DOM. A unit
// test of the strings would stay green with the block wired to nothing; this
// seeds only what the server would return and reads the rendered page, so it
// fails if the block stops offering a clock-in, stops showing the live bar on
// the clock, stops requiring a cost code, drops the note, or stops honouring
// today's toolbox talk.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep the read helpers real (formatClock/elapsedWorkSeconds/isOnTheClock) but
// hold the network still: the writes and reads all become resolved spies, so a
// cache invalidation after a punch never reaches for a server behind the test.
// vi.mock is hoisted above the file, so the spy is defined via vi.hoisted.
const { clockInSpy, costCodesHolder } = vi.hoisted(() => ({
  clockInSpy: vi.fn(async () => ({}) as unknown),
  // The project-aware clock picker (slice 3) reads getClockCostCodesForProject;
  // this holder lets each mount seed what it returns.
  costCodesHolder: { current: [] as unknown[] },
}));
vi.mock("../../lib/timeclock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/timeclock")>();
  return {
    ...actual,
    clockIn: clockInSpy,
    getOpenShift: vi.fn(async () => null),
    listCostCodes: vi.fn(async () => []),
    listRecentJobs: vi.fn(async () => []),
    getJobLastGeo: vi.fn(async () => null),
  };
});
vi.mock("../../lib/costCodes", () => ({
  getClockCostCodesForProject: vi.fn(async () => costCodesHolder.current),
}));
// The talk is signed IN the block now (2026-09-06), through the real
// ToolboxSignCard. Since offline toolbox signing (2026-09-25) a signature is
// kept in the phone's outbox — the REAL one here, on its in-memory store — and
// every gate counts it from there. The spy stands in only for building the
// PDF: it puts a real signature on the phone, so the block reads the real
// gate, and a test that keeps the card mounted forever cannot pass by
// accident (review, 2026-09-06).
const { submitSpy, pushToastSpy, completionHolder, signNow, geoHolder } = vi.hoisted(() => {
  const completionHolder = { current: null as unknown };
  const signNow = async (opts: {
    talk: { id: string };
    profileId: string;
    typedName: string;
    signatureDataUrl: string;
  }) => {
    const { enqueueToolboxSign } = await import("../../lib/offline/outbox");
    const clientId = crypto.randomUUID();
    const signedAt = new Date().toISOString();
    await enqueueToolboxSign(
      {
        clientId,
        profileId: opts.profileId,
        talkId: opts.talk.id,
        talkDate: null,
        typedName: opts.typedName,
        signedAt,
        talkSnapshot: "{}",
        signaturePath: `${opts.profileId}/${opts.talk.id}/${clientId}-signature.png`,
        signatureDataUrl: opts.signatureDataUrl,
        pdfPath: null,
      },
      null,
    );
    return { id: `pending:${clientId}`, signed_at: signedAt, pending: true } as unknown;
  };
  return {
    completionHolder,
    signNow,
    submitSpy: vi.fn(signNow),
    pushToastSpy: vi.fn(),
    // The location wait before a punch: immediate unless a test holds it.
    geoHolder: { current: null as null | Promise<unknown> },
  };
});
vi.mock("../../lib/geo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/geo")>();
  return {
    ...actual,
    captureGeoSoft: vi.fn(async () => (geoHolder.current ? geoHolder.current : {})),
    captureGeoIfGranted: vi.fn(async () => null),
  };
});
// The refused-punch hand-off says what happened; catch the sentence.
vi.mock("../../lib/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/toast")>();
  return { ...actual, pushToast: pushToastSpy };
});
vi.mock("../../lib/toolbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/toolbox")>();
  return {
    ...actual,
    signToolboxTalk: submitSpy,
    myTodayCompletion: vi.fn(async () => completionHolder.current),
  };
});

import { ClockInBlock } from "./ClockInBlock";
import type { ClockPunch, TimeShift } from "../../lib/timeclock";
import { discardFailed, listAll } from "../../lib/offline/outbox";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  completionHolder.current = null;
  geoHolder.current = null;
  clockInSpy.mockClear();
  submitSpy.mockClear();
  pushToastSpy.mockClear();
  // A signature or punch one test left on the phone must not open the next
  // test's gate.
  for (const e of await listAll()) await discardFailed(e.id);
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

/** No signal: what the phone keeps stays on it (the outbox does not drain). */
function noSignal() {
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
}

interface Seed {
  /** The signed-in role (slice 5 gates quick-create vs. "need a job"). */
  role?: string;
  shift?: TimeShift | null;
  costCodes?: unknown[];
  // Per-project cost-code subsets (slice 3): seed a distinct list per project id
  // so a job switch reads a real, different subset from the cache.
  costCodesByProject?: Record<string, unknown[]>;
  recents?: unknown[];
  projects?: unknown[];
  talk?: unknown;
  toolboxDone?: unknown;
}

function mount(seed: Seed = {}): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  qc.setQueryData(["myProfile"], {
    id: "me",
    role: seed.role ?? "installer",
    display_name: "Dana",
  });
  qc.setQueryData(["openShift", "me"], seed.shift ?? null);
  // The picker follows the chosen job; seed both the primed ("p1") and unprimed
  // ("all") scopes so the cost codes are there synchronously either way, and
  // point the mocked fetch at the same list for any other scope.
  costCodesHolder.current = seed.costCodes ?? [];
  qc.setQueryData(["clockCostCodes", "all"], seed.costCodes ?? []);
  qc.setQueryData(["clockCostCodes", "p1"], seed.costCodes ?? []);
  // A distinct subset per project id, so switching jobs reads a different list
  // synchronously (staleTime Infinity means a seeded key never refetches).
  for (const [pid, list] of Object.entries(seed.costCodesByProject ?? {})) {
    qc.setQueryData(["clockCostCodes", pid], list);
  }
  qc.setQueryData(["recentJobs", "me"], seed.recents ?? []);
  qc.setQueryData(["projects"], seed.projects ?? []);
  qc.setQueryData(["todayTalk"], seed.talk ?? null);
  qc.setQueryData(["toolboxToday", "me"], seed.toolboxDone ?? null);

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <ClockInBlock />
      </QueryClientProvider>,
    );
  });
  return host;
}

const CC = { id: "cc1", code: "100", label: "Install", active: true };
function recent(costCodeId: string | null) {
  return {
    projectId: "p1",
    jobCode: "BLACK22",
    name: "Black Desert",
    costCodeId,
    lastClockInAt: new Date().toISOString(),
  };
}

function openShift(hoursAgo: number): TimeShift {
  return {
    id: "s1",
    profile_id: "me",
    project_id: "p1",
    cost_code_id: "cc1",
    clock_in_at: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    clock_out_at: null,
    break_seconds: 0,
    break_started_at: null,
    break_type: null,
    injured: null,
    time_confirmed: null,
    status: "open",
    created_at: new Date().toISOString(),
    note: null,
    projects: { job_code: "BLACK22", name: "Black Desert" },
    cost_codes: { code: "100", label: "Install" },
  };
}

describe("the clock-in block", () => {
  it("shows the big off-the-clock card with the pick flow", () => {
    const el = mount({ costCodes: [CC], recents: [recent(null)], projects: [] });
    expect(el.querySelector(".clockin-block")).toBeTruthy();
    expect(el.querySelector(".clockin-bar")).toBeNull();
    expect(el.textContent).toContain("Clock in");
    expect(el.textContent).toContain("Cost code");
  });

  it("collapses to a slim bar with a running timer on the clock", () => {
    const el = mount({ shift: openShift(1) });
    expect(el.querySelector(".clockin-block")).toBeNull();
    const bar = el.querySelector(".clockin-bar");
    expect(bar).toBeTruthy();
    const timer = el.querySelector(".clockin-bar-timer");
    expect(timer?.textContent).toMatch(/^\d+:\d\d:\d\d$/);
    expect(el.textContent).toContain("BLACK22");
    expect(el.textContent).toContain("Clock out");
  });

  it("requires a cost code before the button will start", () => {
    // A recent job with no last cost code primes the job but not the code.
    const el = mount({ costCodes: [CC], recents: [recent(null)] });
    const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big");
    expect(start).toBeTruthy();
    expect(start!.disabled).toBe(true);

    const code = el.querySelector<HTMLButtonElement>(".clock-costcode-item");
    act(() => code!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(
      el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!.disabled,
    ).toBe(false);
  });

  it("carries the typed note through to the clock-in", async () => {
    const el = mount({ costCodes: [CC], recents: [recent("cc1")] });
    const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big");
    expect(start!.disabled).toBe(false); // job + code both primed

    const textarea = el.querySelector<HTMLTextAreaElement>("#clockin-block-note")!;
    const nativeSet = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      nativeSet.call(textarea, "left the gate open");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      start!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clockInSpy).toHaveBeenCalledTimes(1);
    // The 5th arg is the job mode (slice 2). This recent job isn't in the
    // projects list, so its mode is unknown → null (unchanged, mode-less punch).
    // The 6th is the tap's one-time id and time (Release 0, K0.2).
    expect(clockInSpy.mock.calls[0]).toEqual([
      "p1",
      "cc1",
      expect.anything(),
      "left the gate open",
      null,
      expect.objectContaining({ clientId: expect.any(String), tappedAt: expect.any(String) }),
    ]);
  });

  it("won't clock in until today's toolbox talk is signed", () => {
    // A talk exists today and isn't signed: the button becomes "sign first",
    // and the plain clock-in is not offered.
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      talk: { id: "t1", title: "Ladders" },
      toolboxDone: null,
    });
    expect(el.textContent).toContain("Sign safety talk & clock in");
    expect(el.textContent).toContain("Sign today's safety talk to clock in.");
    expect(el.textContent).not.toContain("Start clock");
    expect(clockInSpy).not.toHaveBeenCalled();
  });

  // ---- Sign the talk in the block (owner ask, 2026-09-06) -----------------
  // The signature pad draws on a canvas, and happy-dom's getContext("2d")
  // answers null — the pad then never marks itself dirty and the Sign button
  // would stay held. A minimal context stub lets the real card run its own
  // pointer handlers; nothing about the block or the card is mocked.
  function stubCanvas() {
    const ctx = {
      setTransform() {},
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
    };
    const proto = window.HTMLCanvasElement.prototype;
    const getContext = vi
      .spyOn(proto, "getContext")
      .mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
    const toDataURL = vi
      .spyOn(proto, "toDataURL")
      .mockImplementation(() => "data:image/png;base64,AAAA");
    return () => {
      getContext.mockRestore();
      toDataURL.mockRestore();
    };
  }

  function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const nativeSet = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    act(() => {
      nativeSet.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** Pledge, typed name, one drawn stroke — everything the card needs. */
  function fillSignCard(el: HTMLElement) {
    const pledge = el.querySelector<HTMLInputElement>(".ack-row input[type=checkbox]")!;
    act(() => pledge.click());
    setValue(el.querySelector<HTMLInputElement>('input[placeholder="Full name"]')!, "Dana Ortiz");
    const canvas = el.querySelector<HTMLCanvasElement>("canvas.sig-canvas")!;
    act(() => {
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5, pointerId: 1 }),
      );
      canvas.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, clientX: 40, clientY: 12, pointerId: 1 }),
      );
      canvas.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, clientX: 40, clientY: 12, pointerId: 1 }),
      );
    });
  }

  async function settle() {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it("tapping the held button shows the talk in the block and does not open the sheet", () => {
    const restore = stubCanvas();
    const dispatch = vi.spyOn(window, "dispatchEvent");
    try {
      const el = mount({
        costCodes: [CC],
        recents: [recent("cc1")],
        talk: { id: "t1", title: "Ladders", body: "Three points of contact.", talk_date: "2026-09-06" },
        toolboxDone: null,
      });
      // Not a scroll-past every morning: the talk is hidden until the tap.
      expect(el.textContent).not.toContain("Today's toolbox talk");
      const big = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!;
      act(() => big.dispatchEvent(new MouseEvent("click", { bubbles: true })));

      // The talk is in the block, with the whole sign-off in it …
      expect(el.querySelector(".clockin-block")!.textContent).toContain("Today's toolbox talk");
      expect(el.textContent).toContain("Ladders");
      expect(el.textContent).toContain("I read and understood today's talk");
      expect(el.querySelector("canvas.sig-canvas")).toBeTruthy();
      expect(byText(el, "Sign today's talk")).toBeTruthy();
      // … the pickers made on the landing are still there, still chosen …
      expect(el.querySelector(".clock-chip.current")?.textContent).toContain("BLACK22");
      expect(el.querySelector(".clock-costcode-item.selected")).toBeTruthy();
      // … and nothing asked the sheet to open.
      const opened = dispatch.mock.calls.filter(
        ([ev]) => (ev as Event).type === "infinity:open-clock",
      );
      expect(opened).toHaveLength(0);
      expect(clockInSpy).not.toHaveBeenCalled();
    } finally {
      dispatch.mockRestore();
      restore();
    }
  });

  it("signing queues one clock-in behind the signature, with the block's job, cost code, note and mode", async () => {
    // Offline toolbox signing (2026-09-25): the signature is kept on the
    // phone, and the punch it triggers waits behind it in the outbox. Sent
    // straight to the server, the punch would arrive before the signature
    // and be refused on the toolbox gate. Driven with no signal so both stay
    // on the phone where this can read them.
    noSignal();
    const restore = stubCanvas();
    try {
      const el = mount({
        costCodes: [CC],
        recents: [recent("cc1")],
        // A single-mode tracking job: the mode rides along silently.
        projects: [
          {
            id: "p1",
            job_code: "BLACK22",
            name: "Black Desert",
            address: null,
            status: "active",
            allowed_modes: ["tracking"],
          },
        ],
        talk: { id: "t1", title: "Ladders", body: "Three points of contact.", talk_date: "2026-09-06" },
        toolboxDone: null,
      });
      setValue(el.querySelector<HTMLTextAreaElement>("#clockin-block-note")!, "gate code 4411");
      act(() =>
        el
          .querySelector<HTMLButtonElement>(".clock-btn.primary.big")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      fillSignCard(el);
      const sign = byText(el, "Sign today's talk")!;
      expect(sign.disabled).toBe(false);
      await clickAndFlush(sign);
      await settle();

      // The signature was recorded once, for this person and this talk …
      expect(submitSpy).toHaveBeenCalledTimes(1);
      expect((submitSpy.mock.calls[0] as unknown[])[0]).toMatchObject({
        profileId: "me",
        typedName: "Dana Ortiz",
        talk: { id: "t1" },
        // The stubbed canvas's export: proof the real pad's handlers ran.
        signatureDataUrl: "data:image/png;base64,AAAA",
      });
      // … and the punch left on its own, exactly once, with everything the
      // block already knew — into the queue behind the signature, never
      // straight to the server ahead of it.
      expect(clockInSpy).not.toHaveBeenCalled();
      const onPhone = await listAll();
      const signature = onPhone.find((e) => e.op === "toolbox_sign")!;
      const punches = onPhone.filter((e) => e.op === "clock_in");
      expect(punches).toHaveLength(1);
      expect(punches[0].dependsOn).toBe(signature.id);
      expect(punches[0].payload).toMatchObject({
        projectId: "p1",
        costCodeId: "cc1",
        note: "gate code 4411",
        mode: "tracking",
        clientId: expect.any(String),
      });
      // On the clock from the phone's own copy, saying the signature waits.
      expect(el.querySelector(".clockin-bar")).toBeTruthy();
      const status = el.querySelector(".toolbox-sign-status")!;
      expect(status.getAttribute("data-state")).toBe("pending");
      expect(status.textContent).toContain("Signed — waiting to send");
    } finally {
      restore();
    }
  });

  it("a second tap on Sign — during the sign or after it — cannot file a second signature or a second punch", async () => {
    // The seconds between the signature and the punch are real on a phone:
    // the PDF is built, and the punch waits on a GPS fix (up to 12.5 s). In
    // that window the card used to sit on screen with its Sign button live
    // again, and a second tap filed a second signature AND a second clock_in
    // — which auto-closes the shift the first one had just opened (review,
    // 2026-09-06). Both halves of the window are driven here: the sign held
    // open, then the punch held open on its location wait.
    noSignal();
    const restore = stubCanvas();
    let finishSign!: () => void;
    let finishGeo!: () => void;
    submitSpy.mockImplementationOnce(
      (opts) =>
        new Promise((resolve) => {
          finishSign = () => resolve(signNow(opts));
        }),
    );
    geoHolder.current = new Promise((resolve) => {
      finishGeo = () => resolve({});
    });
    try {
      const el = mount({
        costCodes: [CC],
        recents: [recent("cc1")],
        projects: [proj(["tracking"])],
        talk: { id: "t1", title: "Ladders", body: "Three points of contact.", talk_date: "2026-09-06" },
        toolboxDone: null,
      });
      act(() =>
        el
          .querySelector<HTMLButtonElement>(".clock-btn.primary.big")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      fillSignCard(el);
      const sign = byText(el, "Sign today's talk")!;
      await clickAndFlush(sign);
      // settle(), not just a microtask flush: React Query paints "pending"
      // through a setTimeout(0) notification, so the held label is only
      // reliably on screen after a timer turn.
      await settle();
      // While the signature is being kept: held, and a tap on it does nothing.
      expect(byText(el, "Signing…")?.disabled).toBe(true);
      await clickAndFlush(byText(el, "Signing…")!);
      expect(submitSpy).toHaveBeenCalledTimes(1);

      await act(async () => finishSign());
      await settle();
      // The moment it is kept: the card is gone from the block — no Sign
      // button to tap twice — and the block's own button is held as the
      // punch waits on its location.
      expect(el.querySelector("canvas.sig-canvas")).toBeNull();
      expect(byText(el, "Sign today's talk")).toBeUndefined();
      const big = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!;
      expect(big.textContent).toContain("Clocking in");
      expect(big.disabled).toBe(true);
      await clickAndFlush(big);

      await act(async () => finishGeo());
      await settle();
      expect(submitSpy).toHaveBeenCalledTimes(1);
      const onPhone = await listAll();
      expect(onPhone.filter((e) => e.op === "toolbox_sign")).toHaveLength(1);
      expect(onPhone.filter((e) => e.op === "clock_in")).toHaveLength(1);
      expect(clockInSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("with no signal, the talk counts as signed at once and the punch waits behind it — no hand-off, no refused punch", async () => {
    // The owner's field report (2026-09-25): a toolbox talk could not be
    // signed with no signal, so nobody could clock in. Now the signature is
    // kept on the phone and counts at once — no read from the server, which
    // hangs here the whole time — and the punch queues behind it instead of
    // going to the server, failing, and handing the sheet a job to redo.
    noSignal();
    const restore = stubCanvas();
    const dispatch = vi.spyOn(window, "dispatchEvent");
    completionHolder.current = new Promise(() => {});
    try {
      const el = mount({
        costCodes: [CC],
        recents: [recent("cc1")],
        projects: [proj(["tracking"])],
        talk: { id: "t1", title: "Ladders", body: "Three points of contact.", talk_date: "2026-09-06" },
        toolboxDone: null,
      });
      act(() =>
        el
          .querySelector<HTMLButtonElement>(".clock-btn.primary.big")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      fillSignCard(el);
      await clickAndFlush(byText(el, "Sign today's talk")!);
      await settle();

      expect(el.querySelector("canvas.sig-canvas")).toBeNull();
      expect(clockInSpy).not.toHaveBeenCalled();
      const opened = dispatch.mock.calls
        .map(([ev]) => ev as CustomEvent)
        .filter((ev) => ev.type === "infinity:open-clock");
      expect(opened).toHaveLength(0);
      expect(pushToastSpy).not.toHaveBeenCalled();
      expect((await listAll()).map((e) => e.op).sort()).toEqual(["clock_in", "toolbox_sign"]);
    } finally {
      dispatch.mockRestore();
      restore();
    }
  });

  // Two jobs with different cost-code subsets: switching from p1 to p2 drops
  // p1's code (the subset effect), which is the way the picks come apart
  // under a revealed talk.
  const twoJobs = () => {
    const install = { id: "ccInstall", code: "100", label: "Install", active: true };
    const service = { id: "ccService", code: "200", label: "Service call", active: true };
    return {
      costCodes: [install],
      recents: [
        { projectId: "p1", jobCode: "BLACK22", name: "Black Desert", costCodeId: "ccInstall", lastClockInAt: new Date().toISOString() },
      ],
      projects: [
        { id: "p1", job_code: "BLACK22", name: "Black Desert", address: null, status: "active", allowed_modes: ["data"] },
        { id: "p2", job_code: "SVC-9", name: "Service Run", address: null, status: "active", allowed_modes: ["data"] },
      ],
      costCodesByProject: { p1: [install], p2: [service] },
      talk: { id: "t1", title: "Ladders", body: "Three points of contact.", talk_date: "2026-09-06" },
      toolboxDone: null,
    };
  };

  async function switchToServiceJob(el: HTMLElement) {
    const toggle = el.querySelectorAll<HTMLButtonElement>(".clock-list-toggle")[0];
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const p2Item = Array.from(el.querySelectorAll<HTMLButtonElement>(".clock-project-item")).find(
      (b) => b.textContent?.includes("SVC-9"),
    )!;
    await clickAndFlush(p2Item);
  }

  it("takes the talk away again when a job switch clears the cost code, and brings it back once one is picked", async () => {
    // The held button is what says "pick a cost code". With the talk
    // revealed and the pickers still live above it, a job switch that drops
    // the code used to leave the card up, and signing punched with
    // cost_code_id null — the record the block's own button refuses
    // (review, 2026-09-06).
    const restore = stubCanvas();
    try {
      const el = mount(twoJobs());
      act(() =>
        el
          .querySelector<HTMLButtonElement>(".clock-btn.primary.big")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      expect(el.querySelector("canvas.sig-canvas")).toBeTruthy();

      await switchToServiceJob(el);
      expect(el.querySelector(".clock-costcode-item.selected")).toBeNull();
      expect(el.querySelector("canvas.sig-canvas")).toBeNull();
      const held = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!;
      expect(held.textContent).toContain("Sign safety talk & clock in");
      expect(held.disabled).toBe(true);
      expect(clockInSpy).not.toHaveBeenCalled();

      // Pick the service job's code: the picks are whole, the talk is back
      // without a second tap on the big button.
      const code = el.querySelector<HTMLButtonElement>(".clock-costcode-item")!;
      act(() => code.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(el.querySelector("canvas.sig-canvas")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("does not punch when the picks came apart while the signature was uploading", async () => {
    // The upload takes seconds. A job switched in that window clears the
    // code and takes the card down, but the sign's own onSuccess still fires
    // (it is an option callback, on purpose). It must NOT clock in with a
    // null cost code off the picks the card was rendered with; the signature
    // stands, the person is told, and the plain Start is what is left.
    noSignal();
    const restore = stubCanvas();
    let finishSign!: () => void;
    submitSpy.mockImplementationOnce(
      (opts) =>
        new Promise((resolve) => {
          finishSign = () => resolve(signNow(opts));
        }),
    );
    try {
      const el = mount(twoJobs());
      act(() =>
        el
          .querySelector<HTMLButtonElement>(".clock-btn.primary.big")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      fillSignCard(el);
      await clickAndFlush(byText(el, "Sign today's talk")!);
      await settle();
      expect(submitSpy).toHaveBeenCalledTimes(1);

      await switchToServiceJob(el);
      expect(el.querySelector("canvas.sig-canvas")).toBeNull();

      await act(async () => finishSign());
      await settle();
      expect(clockInSpy).not.toHaveBeenCalled();
      expect((await listAll()).filter((e) => e.op === "clock_in")).toHaveLength(0);
      expect(pushToastSpy).toHaveBeenCalledTimes(1);
      expect(String(pushToastSpy.mock.calls[0][0])).toContain("Pick a cost code to clock in");
      // Signed: the plain Start is offered, held until a code is picked.
      const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!;
      expect(start.textContent).toContain("Start clock");
      expect(start.disabled).toBe(true);
    } finally {
      restore();
    }
  });

  it("hands a refused punch to the sheet WITH the picks, and says what happened", async () => {
    // Offline, or a server no: the sheet is still the fallback (its outbox
    // queues the punch), but it must open pre-filled and not in silence.
    clockInSpy.mockRejectedValueOnce(new Error("Failed to fetch"));
    const dispatch = vi.spyOn(window, "dispatchEvent");
    try {
      const el = mount({
        costCodes: [CC],
        recents: [recent("cc1")],
        projects: [proj(["tracking"])],
        talk: { id: "t1", title: "Ladders" },
        toolboxDone: { id: "done1" },
      });
      setValue(el.querySelector<HTMLTextAreaElement>("#clockin-block-note")!, "gate code 4411");
      await clickAndFlush(el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!);
      await settle();

      expect(clockInSpy).toHaveBeenCalledTimes(1);
      const opened = dispatch.mock.calls
        .map(([ev]) => ev as CustomEvent)
        .filter((ev) => ev.type === "infinity:open-clock");
      expect(opened).toHaveLength(1);
      // The hand-off carries the tap's WHOLE punch (K0.2/K0.5) — id, tap time
      // and clock check. Saved before its reply was lost, the sheet's retry of
      // that id gets the same shift back; never arrived, it is still paid from
      // this tap and not from the sheet's later one (Codex review, 2026-09-25).
      const punchSent = (clockInSpy.mock.calls[0] as unknown[])[5] as ClockPunch;
      expect(opened[0].detail).toEqual({
        projectId: "p1",
        costCodeId: "cc1",
        note: "gate code 4411",
        mode: "tracking",
        punch: punchSent,
      });
      expect(punchSent).toEqual({
        clientId: expect.any(String),
        tappedAt: expect.any(String),
        clockCheckedAt: null,
        clockSkewMs: null,
      });
      expect(pushToastSpy).toHaveBeenCalledTimes(1);
      expect(String(pushToastSpy.mock.calls[0][0])).toContain("finish in the clock sheet");
      expect(pushToastSpy.mock.calls[0][1]).toBe("error");
    } finally {
      dispatch.mockRestore();
    }
  });

  it("offers the plain clock-in once the talk is signed", () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      talk: { id: "t1", title: "Ladders" },
      toolboxDone: { id: "done1" },
    });
    expect(el.textContent).toContain("Start clock");
    expect(el.textContent).not.toContain("Sign safety talk & clock in");
  });

  // ---- Mode step (standard-tracking-jobs slice 2) --------------------------
  const proj = (allowed_modes: string[]) => ({
    id: "p1",
    job_code: "BLACK22",
    name: "Black Desert",
    address: null,
    status: "active",
    allowed_modes,
  });

  async function clickAndFlush(btn: HTMLButtonElement) {
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function byText(el: HTMLElement, text: string): HTMLButtonElement | undefined {
    return Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.includes(text),
    );
  }

  it("asks Install vs Tracking only when the job allows both", () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [proj(["data", "tracking"])],
    });
    expect(el.textContent).toContain("What are you here to do?");
    expect(el.textContent).toContain("Install work");
    expect(el.textContent).toContain("Tracking only");
  });

  it("stays silent about mode when the job allows only one", () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [proj(["data"])],
    });
    expect(el.textContent).not.toContain("What are you here to do?");
  });

  it("records the picked mode when the job allows both", async () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [proj(["data", "tracking"])],
    });
    // Switch from the default (install work) to tracking only — the mode
    // buttons are the ones carrying aria-pressed.
    const modeBtns = Array.from(
      el.querySelectorAll<HTMLButtonElement>("[aria-pressed]"),
    );
    const tracking = modeBtns.find((b) => b.textContent?.includes("Tracking only"))!;
    act(() => tracking.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!;
    await clickAndFlush(start);

    expect(clockInSpy).toHaveBeenCalledTimes(1);
    expect(clockInSpy.mock.calls[0]).toEqual([
      "p1",
      "cc1",
      expect.anything(),
      null,
      "tracking",
      expect.objectContaining({ clientId: expect.any(String) }),
    ]);
  });

  it("drops a picked cost code that isn't in the job you switch to", async () => {
    // Slice 3 regression: a code valid for job A must not survive a switch to a
    // job B whose subset excludes it — otherwise Start stays enabled and clock-in
    // would record a cost_code_id outside B's per-job subset.
    const install = { id: "ccInstall", code: "100", label: "Install", active: true };
    const service = { id: "ccService", code: "200", label: "Service call", active: true };
    const warranty = { id: "ccWarranty", code: "210", label: "Warranty", active: true };
    const el = mount({
      // Prime job p1 with its own last code (Install), valid for p1's subset.
      costCodes: [install],
      recents: [recent("ccInstall")],
      projects: [
        { id: "p1", job_code: "BLACK22", name: "Black Desert", address: null, status: "active", allowed_modes: ["data"] },
        { id: "p2", job_code: "SVC-9", name: "Service Run", address: null, status: "active", allowed_modes: ["data"] },
      ],
      costCodesByProject: {
        p1: [install],
        // p2 is a service job — Install is NOT one of its codes.
        p2: [service, warranty],
      },
    });
    // Primed: job p1 + Install code → Start is enabled.
    expect(
      el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!.disabled,
    ).toBe(false);

    // Open the full list and switch to the service job p2. The item onClick sets
    // only the project, leaving the Install code held from p1.
    const toggle = el.querySelectorAll<HTMLButtonElement>(".clock-list-toggle")[0];
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const p2Item = Array.from(
      el.querySelectorAll<HTMLButtonElement>(".clock-project-item"),
    ).find((b) => b.textContent?.includes("SVC-9"))!;
    await clickAndFlush(p2Item);

    // Install is gone from the offered codes, nothing is highlighted, and Start
    // is disabled again — no path to submit a code outside p2's subset.
    expect(el.textContent).not.toContain("100 — Install");
    expect(el.querySelector(".clock-costcode-item.selected")).toBeNull();
    expect(
      el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!.disabled,
    ).toBe(true);
    expect(clockInSpy).not.toHaveBeenCalled();
  });

  it("records the one mode silently on a single-mode job", async () => {
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [proj(["tracking"])],
    });
    const start = el.querySelector<HTMLButtonElement>(".clock-btn.primary.big")!;
    await clickAndFlush(start);

    expect(clockInSpy).toHaveBeenCalledTimes(1);
    expect(clockInSpy.mock.calls[0]).toEqual([
      "p1",
      "cc1",
      expect.anything(),
      null,
      "tracking",
      expect.objectContaining({ clientId: expect.any(String) }),
    ]);
  });

  // ---- Quick tracking job / "need a job" (slice 5) -------------------------

  it("offers a foreman a quick tracking job, not the installer's ask", () => {
    const el = mount({ role: "foreman", costCodes: [CC], projects: [] });
    expect(el.textContent).toContain("Start a quick tracking job");
    expect(el.textContent).not.toContain("Need a job for this?");
  });

  it("offers an installer the ask, and refuses them the quick-create", () => {
    const el = mount({ role: "installer", costCodes: [CC], projects: [] });
    expect(el.textContent).toContain("Need a job for this?");
    expect(el.textContent).not.toContain("Start a quick tracking job");
  });

  it("surfaces an open tracking job to join instead of forking a duplicate", () => {
    const el = mount({
      role: "foreman",
      costCodes: [CC],
      projects: [
        {
          id: "pX",
          job_code: "WARR-1",
          name: "Warranty callback",
          address: null,
          status: "active",
          allowed_modes: ["tracking"],
        },
      ],
    });
    // Open the quick-job panel and type a matching name.
    act(() => byText(el, "Start a quick tracking job")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    ));
    const nameInput = el.querySelector<HTMLInputElement>(
      'input[placeholder="Job name (optional)"]',
    )!;
    const nativeSet = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      nativeSet.call(nameInput, "warranty");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The de-dupe list surfaces the live job as a chip to join.
    expect(el.textContent).toContain("Already open — join one instead");
    expect(byText(el, "WARR-1")).toBeTruthy();
  });
});

// K0.1: a clock-in still on the phone counts as real. The block reads the
// same merged view the provider does, so once a punch is queued it shows the
// on-the-clock bar and never offers the big button again. Driven through the
// REAL outbox (its in-memory store under vitest) with the phone offline, so
// this proves the block sees what the queue holds, not what a mock says.
import { enqueueClockIn, enqueueClockOut } from "../../lib/offline/outbox";

describe("a clock punch still on the phone (K0.1)", () => {
  const queuedIds: string[] = [];
  const PUNCH = {
    clientId: "9b2f0c14-7d3a-4e51-8a06-3f2c9d1e4b77",
    tappedAt: "2026-09-23T13:02:00.000Z",
    clockCheckedAt: null,
    clockSkewMs: null,
  };
  const goOffline = () => Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

  afterEach(async () => {
    for (const id of queuedIds.splice(0)) await discardFailed(id);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("shows the bar, the tap time and 'saved on this phone' — and no Start button — once a clock-in is queued", async () => {
    goOffline();
    const el = mount({
      costCodes: [CC],
      recents: [recent("cc1")],
      projects: [{ id: "p1", job_code: "BLACK22", name: "Black Desert", address: null, status: "active", allowed_modes: ["data"] }],
    });
    expect(el.querySelector(".clock-btn.primary.big")).toBeTruthy();

    await act(async () => {
      queuedIds.push(await enqueueClockIn({ projectId: "p1", costCodeId: "cc1", punch: PUNCH }));
    });

    expect(el.querySelector(".clock-btn.primary.big")).toBeNull();
    expect(el.querySelector(".clockin-block")).toBeNull();
    const bar = el.querySelector(".clockin-bar")!;
    expect(bar).toBeTruthy();
    expect(bar.textContent).toContain("BLACK22");
    const line = bar.querySelector(".clock-queue-line")!;
    expect(line.getAttribute("data-kind")).toBe("clock_in");
    expect(line.textContent).toContain("saved on this phone");
    expect(line.textContent).toContain(new Date(PUNCH.tappedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    // Counting from the tap, not from zero.
    expect(el.querySelector(".clockin-bar-timer")?.textContent).not.toBe("0:00:00");
  });

  it("shows the person off the clock, with the clock-out saved on this phone, once a clock-out is queued", async () => {
    goOffline();
    const el = mount({ shift: openShift(2), costCodes: [CC], recents: [recent("cc1")] });
    expect(el.querySelector(".clockin-bar")).toBeTruthy();

    await act(async () => {
      queuedIds.push(
        await enqueueClockOut({ shiftRef: "s1", injured: false, timeConfirmed: true, breakSeconds: 0, punch: PUNCH }),
      );
    });

    expect(el.querySelector(".clockin-bar")).toBeNull();
    const block = el.querySelector(".clockin-block")!;
    expect(block).toBeTruthy();
    const line = block.querySelector(".clock-queue-line")!;
    expect(line.getAttribute("data-kind")).toBe("clock_out");
    expect(line.textContent).toContain("Clocked out");
    expect(line.textContent).toContain("saved on this phone");
  });
});

import { describe, expect, it } from "vitest";
import { CATALOG, translate, type Lang, type TFn } from "../i18n";
import type { InstallOutboxRecord } from "../install/installOutbox";
import type { OutboxEntry } from "./outbox-core";
import { buildStuckRows, stateLabel, writeLabel, type StuckInputs } from "./stuckRows";

const en: TFn = (key, vars) => translate(CATALOG, "en" as Lang, key, vars);
const es: TFn = (key, vars) => translate(CATALOG, "es" as Lang, key, vars);

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function write(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: "w-1",
    op: "photo_upload",
    payload: { kind: "photo" },
    createdAt: NOW - HOUR,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: NOW,
    dependsOn: null,
    hasBlob: true,
    ...over,
  };
}

function install(over: Partial<InstallOutboxRecord> = {}): InstallOutboxRecord {
  return {
    id: "i-1",
    step: "queued",
    installEventId: null,
    attemptCount: 0,
    nextAttemptAt: 0,
    lastError: null,
    status: "pending",
    payload: {
      clientKey: "k",
      openingId: "o",
      projectId: "p",
      openingCode: "W1",
      assignedWindowId: null,
      createdBy: null,
      submitParams: { openingId: "o" },
      points: null,
      media: [],
      createdAt: new Date(NOW - 2 * HOUR).toISOString(),
    },
    ...over,
  };
}

const EMPTY: StuckInputs = {
  writes: [],
  installs: [],
  isInstallSending: () => false,
  work: [],
  service: [],
  serviceMedia: [],
  legacy: 0,
  sentWrites: [],
  sentInstalls: [],
};

describe("buildStuckRows — every queue, every state", () => {
  it("lists nothing for a phone with nothing anywhere", () => {
    expect(buildStuckRows(EMPTY, en)).toEqual({ needsYou: [], waiting: [], sent: [] });
  });

  // The bug this screen used to have: only what had GIVEN UP was listed.
  it("lists a photo that is merely waiting, with its age, as saved on this phone", () => {
    const { waiting, needsYou } = buildStuckRows({ ...EMPTY, writes: [write()] }, en);
    expect(needsYou).toEqual([]);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      id: "w-1",
      label: "Photo",
      when: NOW - HOUR,
      state: "waiting",
      canRetry: false,
      canDiscard: false,
      reviewTo: null,
    });
    expect(stateLabel(waiting[0].state, en)).toBe("Saved on this phone");
  });

  it("shows an entry a drain is attempting as sending", () => {
    const { waiting } = buildStuckRows({ ...EMPTY, writes: [write({ status: "sending" })] }, en);
    expect(waiting[0].state).toBe("sending");
    expect(stateLabel("sending", en)).toBe("Sending…");
  });

  it("keeps a write that gave up under needs-you, with Try again and Throw away", () => {
    const { needsYou, waiting } = buildStuckRows(
      { ...EMPTY, writes: [write({ status: "failed", lastError: "Failed to fetch" })] },
      en,
    );
    expect(waiting).toEqual([]);
    expect(needsYou[0]).toMatchObject({
      state: "failed",
      detail: "Failed to fetch",
      canRetry: true,
      canDiscard: true,
    });
    expect(stateLabel("failed", en)).toBe("Couldn't send — needs you");
  });

  it("names a unit's memo and video by what they are, not as photos", () => {
    const memo = write({ id: "m", payload: { kind: "voice_memo" } });
    const video = write({ id: "v", payload: { kind: "video" } });
    expect(writeLabel(memo, en)).toBe("Voice memo");
    expect(writeLabel(video, en)).toBe("Video");
    expect(writeLabel(memo, es)).toBe("Nota de voz");
    expect(writeLabel(write({ op: "clock_in" }), en)).toBe("Clock in");
  });

  it("shows a finished unit waiting for signal, and which one is on the wire", () => {
    const { waiting } = buildStuckRows(
      {
        ...EMPTY,
        installs: [install(), install({ id: "i-2" })],
        isInstallSending: (id) => id === "i-2",
      },
      en,
    );
    expect(waiting.map((r) => [r.id, r.state])).toEqual([
      ["i-1", "waiting"],
      ["i-2", "sending"],
    ]);
    expect(waiting[0].label).toBe("Window W1 finished");
    expect(waiting[0].when).toBe(NOW - 2 * HOUR);
  });

  it("lists custom-work and servicing rows, and sends their review to the screen that owns it", () => {
    const { waiting, needsYou } = buildStuckRows(
      {
        ...EMPTY,
        work: [
          { id: "c1", userId: "u", action: "start", data: {} },
          { id: "c2", userId: "u", action: "stop", data: {}, error: "Shift already closed." },
        ],
        service: [{ id: "s1", userId: "u", action: "start", data: {} }],
        serviceMedia: [{ id: "sm1", filename: "before.jpg", error: "Audio is saved. Transcription did not finish; tap Retry." }],
      },
      en,
    );
    expect(waiting.map((r) => [r.label, r.reviewTo])).toEqual([
      ["Work change", "/current-work"],
      ["Service change", "/servicing"],
    ]);
    expect(needsYou.map((r) => [r.label, r.detail, r.canRetry, r.canDiscard])).toEqual([
      ["Work change", "Shift already closed.", true, false],
      ["Service photo, memo or video", "Audio is saved. Transcription did not finish; tap Retry.", true, false],
    ]);
    // The command queues record no time; the row says so rather than guessing.
    expect(waiting[0].when).toBe(0);
  });

  it("shows what is still in the old upload store as one waiting row", () => {
    const { waiting } = buildStuckRows({ ...EMPTY, legacy: 3 }, en);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      source: "legacy",
      label: "Old uploads still to move: 3",
      state: "waiting",
      canRetry: false,
    });
  });

  it("orders newest first and puts rows with no time last", () => {
    const { waiting } = buildStuckRows(
      {
        ...EMPTY,
        writes: [write({ id: "old", createdAt: NOW - 5 * HOUR }), write({ id: "new", createdAt: NOW - HOUR })],
        work: [{ id: "c1", userId: "u", action: "start", data: {} }],
        installs: [install({ id: "mid" })],
      },
      en,
    );
    expect(waiting.map((r) => r.id)).toEqual(["new", "mid", "old", "work:c1"]);
  });

  it("lists what reached the server this session as saved in Forge, newest first", () => {
    const { sent } = buildStuckRows(
      {
        ...EMPTY,
        sentWrites: [{ entry: write({ id: "w-sent" }), sentAt: NOW - 60_000 }],
        sentInstalls: [
          { id: "i-sent", openingCode: "W2", createdAt: new Date(NOW - HOUR).toISOString(), sentAt: NOW - 10_000 },
        ],
      },
      en,
    );
    expect(sent.map((r) => [r.id, r.label, r.state, r.sentAt])).toEqual([
      ["sent:i-sent", "Window W2 finished", "sent", NOW - 10_000],
      ["sent:w-sent", "Photo", "sent", NOW - 60_000],
    ]);
    expect(stateLabel("sent", en)).toBe("Saved in Forge");
    expect(stateLabel("sent", es)).toBe("Guardado en Forge");
  });
});

// Offline toolbox signing (2026-09-25): a signature Forge refused holds the
// clock-in queued behind it. Both are listed, each honestly — the signature
// under Needs you with Forge's reason, the clock-in under Waiting, saying it
// is waiting for that signature rather than for signal.
describe("a clock-in held behind a refused toolbox talk signature", () => {
  const refused = write({
    id: "sign-1",
    op: "toolbox_sign",
    payload: { clientId: "c1" },
    status: "failed",
    lastError: "This toolbox talk signature belongs to someone else on this phone.",
    createdAt: NOW - 2 * HOUR,
  });
  const held = write({ id: "in-1", op: "clock_in", payload: {}, hasBlob: false, dependsOn: "sign-1", createdAt: NOW - HOUR });

  it("names the signature, with Forge's reason, under Needs you", () => {
    const { needsYou } = buildStuckRows({ ...EMPTY, writes: [refused, held] }, en);
    expect(needsYou).toHaveLength(1);
    expect(needsYou[0]).toMatchObject({
      id: "sign-1",
      label: "Toolbox talk signature",
      state: "failed",
      canRetry: true,
      canDiscard: true,
    });
    expect(needsYou[0].detail).toContain("belongs to someone else");
  });

  it("keeps the clock-in under Waiting, saying what it waits for, in both languages", () => {
    const { waiting } = buildStuckRows({ ...EMPTY, writes: [refused, held] }, en);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ id: "in-1", label: "Clock in", state: "waiting", canRetry: false, canDiscard: false });
    expect(waiting[0].detail).toContain("toolbox talk signature");
    const spanish = buildStuckRows({ ...EMPTY, writes: [refused, held] }, es).waiting[0];
    expect(spanish.label).toBe("Marcar entrada");
    expect(spanish.detail).toContain("firma de la charla de seguridad");
  });

  it("says nothing extra about a clock-in whose signature is merely waiting for signal", () => {
    const waitingSign = { ...refused, status: "queued" as const, lastError: null };
    const { waiting } = buildStuckRows({ ...EMPTY, writes: [waitingSign, held] }, en);
    expect(waiting.map((r) => [r.id, r.detail])).toEqual([
      ["in-1", null],
      ["sign-1", null],
    ]);
    expect(waiting.find((r) => r.id === "sign-1")?.label).toBe("Toolbox talk signature");
  });
});

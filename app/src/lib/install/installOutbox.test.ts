import { describe, expect, it } from "vitest";
import {
  deserializeInstallOutbox,
  nextInstallStep,
  serializeInstallOutbox,
  stageToAttempt,
  type InstallOutboxRecord,
} from "./installOutbox";

const RECORD: InstallOutboxRecord = {
  id: "outbox-1",
  step: "queued",
  installEventId: null,
  payload: {
    clientKey: "client-key-1",
    openingId: "opening-1",
    projectId: "project-1",
    openingCode: "W1",
    assignedWindowId: "window-1",
    createdBy: "installer@crew.com",
    submitParams: {
      openingId: "opening-1",
      minutes: 12,
      qualityGrade: 4,
      estimateMinutes: 15,
      startedAt: "2026-07-18T12:00:00.000Z",
    },
    points: {
      profileId: "profile-1",
      entries: [{ kind: "install", points: 20 }],
      ref: "opening-1",
      status: "pending",
    },
    media: [
      {
        bucket: "install-media",
        path: "project-1/W1/memo.webm",
        contentType: "audio/webm",
        kind: "voice_memo",
      },
    ],
    createdAt: "2026-07-18T12:00:00.000Z",
  },
};

describe("install outbox state machine", () => {
  it("advances queued → rpc → points → media → complete", () => {
    expect(nextInstallStep("queued")).toBe("rpc_done");
    expect(nextInstallStep("rpc_done")).toBe("points_done");
    expect(nextInstallStep("points_done")).toBe("media_done");
    expect(nextInstallStep("media_done")).toBe("complete");
  });

  it("maps each step to exactly one network stage", () => {
    expect(stageToAttempt("queued")).toBe("rpc");
    expect(stageToAttempt("rpc_done")).toBe("points");
    expect(stageToAttempt("points_done")).toBe("media");
    expect(stageToAttempt("media_done")).toBeNull();
  });

  it("round-trips a full outbox record", () => {
    expect(deserializeInstallOutbox(serializeInstallOutbox(RECORD))).toEqual(
      RECORD,
    );
  });

  it("round-trips after rpc_done with an event id", () => {
    const mid: InstallOutboxRecord = {
      ...RECORD,
      step: "rpc_done",
      installEventId: "event-1",
    };
    expect(deserializeInstallOutbox(serializeInstallOutbox(mid))).toEqual(mid);
  });

  it("rejects corrupt JSON", () => {
    expect(deserializeInstallOutbox("not json")).toBeNull();
  });

  it("rejects records missing required payload fields", () => {
    expect(
      deserializeInstallOutbox(
        JSON.stringify({ id: "x", step: "queued", payload: { openingId: "o" } }),
      ),
    ).toBeNull();
  });
});

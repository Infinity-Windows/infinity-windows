// The pure half of offline toolbox signing (2026-09-25): where a signature's
// files go, and which signature still on the phone counts for today.

import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "./offline/outbox-core";
import {
  localDateOf,
  pendingCompletionOf,
  signaturePngBytes,
  signedToday,
  todaysPendingSignature,
  toolboxRecordPaths,
} from "./toolboxSign";

const ME = "2b1c9f0e-1111-4a2b-8c3d-000000000001";
const TALK = "7d0f3a2e-2222-4b3c-9d4e-000000000002";
const CLIENT = "0e9b8c7d-3333-4c4d-8e5f-000000000003";

describe("toolboxRecordPaths", () => {
  it("is decided by the signer, the talk and the client id — the same inputs give the same files", () => {
    const at = new Date(2026, 8, 25, 7, 2, 11);
    const a = toolboxRecordPaths(ME, TALK, CLIENT, at);
    // A resend an hour later, from a reloaded app, lands on the same files.
    const b = toolboxRecordPaths(ME, TALK, CLIENT, new Date(at));
    expect(a).toEqual(b);
    expect(a).toEqual({
      signaturePath: `${ME}/${TALK}/2026-09-25-${CLIENT}-signature.png`,
      pdfPath: `${ME}/${TALK}/2026-09-25-${CLIENT}.pdf`,
    });
  });

  it("starts in the signer's own folder, the one a test login may write", () => {
    const { signaturePath, pdfPath } = toolboxRecordPaths(ME, TALK, CLIENT, new Date());
    expect(signaturePath.split("/")[0]).toBe(ME);
    expect(pdfPath.split("/")[0]).toBe(ME);
  });

  it("gives a different signature different files", () => {
    const at = new Date(2026, 8, 25);
    expect(toolboxRecordPaths(ME, TALK, CLIENT, at).pdfPath).not.toBe(
      toolboxRecordPaths(ME, TALK, "0e9b8c7d-3333-4c4d-8e5f-000000000004", at).pdfPath,
    );
  });
});

describe("signaturePngBytes", () => {
  it("decodes the pad's data URL to the PNG's bytes", () => {
    const bytes = signaturePngBytes("data:image/png;base64,iVBORw0KGgo=");
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("is empty for a data URL with nothing in it, rather than throwing", () => {
    expect(signaturePngBytes("data:image/png;base64,").length).toBe(0);
    expect(signaturePngBytes("").length).toBe(0);
  });
});

function signEntry(over: Partial<OutboxEntry> & { payload?: Record<string, unknown> } = {}): OutboxEntry {
  const { payload, ...rest } = over;
  return {
    id: CLIENT,
    op: "toolbox_sign",
    payload: {
      clientId: CLIENT,
      profileId: ME,
      talkId: TALK,
      typedName: "Dana Reyes",
      signedAt: new Date(2026, 8, 25, 6, 55).toISOString(),
      talkSnapshot: "{}",
      signaturePath: `${ME}/${TALK}/x-signature.png`,
      pdfPath: `${ME}/${TALK}/x.pdf`,
      ...payload,
    },
    createdAt: 0,
    attemptCount: 0,
    lastError: null,
    status: "queued",
    nextAttemptAt: 0,
    dependsOn: null,
    hasBlob: true,
    ...rest,
  };
}

describe("which signature on the phone counts for today", () => {
  const morning = new Date(2026, 8, 25, 7, 30);

  it("today's, for this person", () => {
    const e = signEntry();
    expect(todaysPendingSignature([e], ME, morning)?.entryId).toBe(CLIENT);
  });

  it("not somebody else's, even on the same phone", () => {
    expect(todaysPendingSignature([signEntry()], "someone-else", morning)).toBeNull();
  });

  it("not yesterday's — a new day has its own talk", () => {
    const yesterday = signEntry({ payload: { signedAt: new Date(2026, 8, 24, 23, 50).toISOString() } });
    expect(todaysPendingSignature([yesterday], ME, morning)).toBeNull();
  });

  it("the newest of today's, when there are two", () => {
    const first = signEntry({ id: "first", payload: { signedAt: new Date(2026, 8, 25, 6, 0).toISOString() } });
    const second = signEntry({ id: "second", payload: { signedAt: new Date(2026, 8, 25, 6, 30).toISOString() } });
    expect(todaysPendingSignature([second, first], ME, morning)?.entryId).toBe("second");
  });

  it("a refused one too, with its reason — it still holds the clock-in", () => {
    const refused = signEntry({ status: "failed", lastError: "Forge said no." });
    expect(todaysPendingSignature([refused], ME, morning)).toMatchObject({ status: "failed", lastError: "Forge said no." });
  });

  it("ignores everything that is not a signature", () => {
    const punch = { ...signEntry(), op: "clock_in" as const };
    expect(todaysPendingSignature([punch], ME, morning)).toBeNull();
  });
});

describe("a signature on the phone, read as today's completion", () => {
  it("carries what the gates and the clock read — the time it was signed above all", () => {
    const view = pendingCompletionOf(todaysPendingSignature([signEntry()], ME, new Date(2026, 8, 25, 7))!);
    expect(view).toMatchObject({
      id: `pending:${CLIENT}`,
      talk_id: TALK,
      profile_id: ME,
      typed_name: "Dana Reyes",
      signed_at: new Date(2026, 8, 25, 6, 55).toISOString(),
      signed_via: "self",
      pending: true,
      sendFailed: false,
      // Nothing to open until Forge has it.
      pdf_path: null,
    });
  });
});

describe("signedToday", () => {
  it("is true for a time on the phone's own today, false for yesterday or nothing", () => {
    const now = new Date(2026, 8, 25, 0, 10);
    expect(signedToday(new Date(2026, 8, 25, 0, 5).toISOString(), now)).toBe(true);
    expect(signedToday(new Date(2026, 8, 24, 23, 59).toISOString(), now)).toBe(false);
    expect(signedToday(null, now)).toBe(false);
    expect(signedToday("not a date", now)).toBe(false);
  });

  it("uses the phone's calendar day", () => {
    expect(localDateOf(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

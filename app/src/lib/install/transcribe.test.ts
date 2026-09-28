// A memo is transcribed as the person it belongs to (Codex review of #660,
// P2 #3). The outbox sends a memo through a client bound to its owner's token;
// the transcription it kicks off used to go through the shared client, which
// carries whoever is signed in by the time the request leaves — after an
// audio conversion that can take seconds. Every call the helper makes must go
// through the client it is handed.

import { describe, expect, it, vi } from "vitest";

// The shared client must not be touched at all when a client is handed in.
vi.mock("../supabase", () => ({
  supabase: new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`the shared client was used (${String(prop)})`);
      },
    },
  ),
}));
vi.mock("../voiceAudio", () => ({ speechAudio: async (blob: Blob) => blob }));

const { transcribeInstallAttachment } = await import("./transcribe");

function boundClient(calls: string[]) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            calls.push(`read:${table}`);
            return { data: { storage_path: "install-media/job/memo.webm" }, error: null };
          },
        }),
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          calls.push(`download:${bucket}/${path}`);
          return { data: new Blob(["memo"], { type: "audio/webm" }), error: null };
        },
      }),
    },
    functions: {
      invoke: async (fn: string) => {
        calls.push(`invoke:${fn}`);
        return { data: { ok: true }, error: null };
      },
    },
  };
}

describe("transcribing a memo", () => {
  it("reads, downloads and asks for the transcript through the client it is handed — never the shared one", async () => {
    const calls: string[] = [];
    const client = boundClient(calls) as unknown as Parameters<typeof transcribeInstallAttachment>[2];
    await transcribeInstallAttachment("attachment-1", undefined, client);
    expect(calls).toEqual([
      "read:attachments",
      "download:install-media/job/memo.webm",
      "invoke:transcribe-install-memo",
    ]);
  });

  it("with the recording in hand, only the transcript request goes out — through that same client", async () => {
    const calls: string[] = [];
    const client = boundClient(calls) as unknown as Parameters<typeof transcribeInstallAttachment>[2];
    await transcribeInstallAttachment("attachment-1", new Blob(["memo"]), client);
    expect(calls).toEqual(["invoke:transcribe-install-memo"]);
  });
});

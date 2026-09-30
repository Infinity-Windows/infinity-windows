// The training illustration editor (2026-09-30): crew must never see a
// generated diagram a foreman hasn't approved, a foreman's hand-edited
// wording must never be silently replaced by the next AI regen, and an
// already-approved illustration must survive that regen untouched. These
// tests pin the three pieces that make that true:
//   * visibleVisualAids — the one gate every crew-facing render and the
//     signed PDF/snapshot go through;
//   * setVisualAidApproval — the read-modify-write that flips one aid's
//     reviewer state without disturbing its neighbors;
//   * regenerateVisualAid — asks for exactly one image, priced and gated as
//     one image, never the whole-talk call.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SafetyTalk } from "./ops";
import type { ReviewableVisualAid } from "./toolbox";

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
}));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("./supabase", () => {
  function builder() {
    let mode: "select" | "update" = "select";
    let patch: Record<string, unknown> | null = null;
    const b: Record<string, unknown> = {
      select: () => {
        mode = "select";
        return b;
      },
      update: (p: Record<string, unknown>) => {
        mode = "update";
        patch = p;
        return b;
      },
      eq: () => b,
      single: () => Promise.resolve({ data: db.row, error: null }),
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        if (mode === "update" && patch) {
          db.updates.push(patch);
          db.row = { ...(db.row ?? {}), ...patch };
        }
        resolve({ data: null, error: null });
      },
    };
    return b;
  }
  return {
    supabase: { from: () => builder(), functions: { invoke } },
    supabaseConfigured: true,
  };
});

const { regenerateVisualAid, setVisualAidApproval, talkSnapshot, visibleVisualAids } =
  await import("./toolbox");

function talk(
  over: Partial<Omit<SafetyTalk, "visual_aids_json">> & {
    visual_aids_json?: ReviewableVisualAid[];
  },
): SafetyTalk {
  return {
    id: "talk-1",
    title: "Ladder safety",
    body: "",
    talk_date: "2026-09-30",
    ...over,
  };
}

beforeEach(() => {
  db.row = null;
  db.updates = [];
  invoke.mockReset();
});

describe("visibleVisualAids", () => {
  it("shows an illustration from before review was required (no approved key at all)", () => {
    const t = talk({ visual_aids_json: [{ prompt: "ladder angle" }] });
    expect(visibleVisualAids(t)).toHaveLength(1);
  });

  it("hides an illustration a foreman hasn't approved yet", () => {
    const t = talk({
      visual_aids_json: [{ prompt: "ladder angle", url: "https://x/1.png", approved: false }],
    });
    expect(visibleVisualAids(t)).toHaveLength(0);
  });

  it("shows an illustration a foreman explicitly approved", () => {
    const t = talk({
      visual_aids_json: [{ prompt: "ladder angle", url: "https://x/1.png", approved: true }],
    });
    expect(visibleVisualAids(t)).toHaveLength(1);
  });

  it("filters a mixed list down to only what crew may see", () => {
    const t = talk({
      visual_aids_json: [
        { prompt: "legacy", url: "https://x/0.png" },
        { prompt: "pending", url: "https://x/1.png", approved: false },
        { prompt: "approved", url: "https://x/2.png", approved: true },
      ],
    });
    expect(visibleVisualAids(t).map((a) => a.prompt)).toEqual(["legacy", "approved"]);
  });
});

describe("talkSnapshot", () => {
  it("never carries a pending illustration's prompt into the signed record", () => {
    const t = talk({
      visual_aids_json: [
        { prompt: "approved diagram", url: "https://x/2.png", approved: true },
        { prompt: "still being revised", url: "https://x/1.png", approved: false },
      ],
    });
    const snap = JSON.parse(talkSnapshot(t));
    expect(snap.visual_aids).toEqual(["approved diagram"]);
  });
});

describe("setVisualAidApproval", () => {
  beforeEach(() => {
    db.row = {
      visual_aids_json: [
        { prompt: "ladder angle", url: "https://x/0.png" },
        { prompt: "glove grip", url: "https://x/1.png" },
      ],
    };
  });

  it("approves one illustration and leaves the other exactly as it was", async () => {
    await setVisualAidApproval("talk-1", 0, true, "foreman-1");
    expect(db.updates).toHaveLength(1);
    const written = db.updates[0].visual_aids_json as Array<Record<string, unknown>>;
    expect(written[0]).toMatchObject({ prompt: "ladder angle", approved: true, approvedBy: "foreman-1" });
    expect(typeof written[0].approvedAt).toBe("string");
    expect(written[1]).toEqual({ prompt: "glove grip", url: "https://x/1.png" });
  });

  it("clears who-and-when on unapprove", async () => {
    db.row = {
      visual_aids_json: [
        { prompt: "ladder angle", url: "https://x/0.png", approved: true, approvedBy: "foreman-1", approvedAt: "2026-09-29T00:00:00.000Z" },
      ],
    };
    await setVisualAidApproval("talk-1", 0, false, "foreman-2");
    const written = db.updates[0].visual_aids_json as Array<Record<string, unknown>>;
    expect(written[0]).toMatchObject({ approved: false, approvedBy: null, approvedAt: null });
  });

  it("refuses to approve a position that doesn't exist rather than writing a hole in the array", async () => {
    await expect(setVisualAidApproval("talk-1", 5, true, "foreman-1")).rejects.toThrow();
    expect(db.updates).toHaveLength(0);
  });
});

describe("regenerateVisualAid", () => {
  it("asks the Edge Function for exactly one illustration, with the revised prompt trimmed", async () => {
    invoke.mockResolvedValue({ data: { ok: true, url: "https://x/new.png" }, error: null });
    const result = await regenerateVisualAid({
      talkId: "talk-1",
      aidIndex: 1,
      prompt: "  glove grip, close-up  ",
    });
    expect(invoke).toHaveBeenCalledWith("generate-toolbox-talk", {
      body: { action: "illustration", talk_id: "talk-1", aid_index: 1, prompt: "glove grip, close-up" },
    });
    expect(result).toEqual({ ok: true, url: "https://x/new.png" });
  });

  it("throws when the call itself fails", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("network down") });
    await expect(
      regenerateVisualAid({ talkId: "talk-1", aidIndex: 0, prompt: "x" }),
    ).rejects.toThrow();
  });

  it("throws when the provider could not produce an image, rather than reporting success", async () => {
    invoke.mockResolvedValue({ data: { ok: false, error: "image generation failed" }, error: null });
    await expect(
      regenerateVisualAid({ talkId: "talk-1", aidIndex: 0, prompt: "x" }),
    ).rejects.toThrow();
  });
});

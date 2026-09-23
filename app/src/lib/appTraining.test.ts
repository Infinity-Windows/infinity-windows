// The rules a "Using Forge" walkthrough passes before it reaches a phone, and
// the two reads that fetch one. The server is the lock
// (scripts/verify-app-training-videos.mjs replays the migration under every
// role); these pin the screen's half — what it trusts, what it narrows, and
// that it never writes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fromSpy, rpcSpy, storageFromSpy, selectResult, signResult } = vi.hoisted(() => ({
  fromSpy: vi.fn(),
  rpcSpy: vi.fn(),
  storageFromSpy: vi.fn(),
  selectResult: { current: { data: [] as unknown[] | null, error: null as unknown } },
  signResult: {
    current: { data: [] as { path: string; signedUrl: string; error: string | null }[] | null, error: null as unknown },
  },
}));

vi.mock("./supabase", () => ({
  supabase: {
    from: fromSpy,
    rpc: rpcSpy,
    storage: { from: storageFromSpy },
  },
}));

import {
  CAPTIONS_MAX_BYTES,
  defaultFetchCaptions,
  TrainingTimeoutError,
  withDeadline,
  canWatchFloor,
  chapterIndexAt,
  formatClock,
  isDesignPreview,
  listTrainingVideos,
  looksLikeWebVtt,
  parseChapters,
  parseTrainingVideo,
  signTrainingMedia,
  SIGNED_URL_SECONDS,
  trainingRoleRank,
  TRAINING_VIDEO_COLS,
  visibleTrainingVideos,
  type TrainingVideo,
} from "./appTraining";
import { isPrivateTrainingMediaUrl } from "./privateMedia";

function rawRow(slug: "installer" | "foreman" | "leadership", extra: Record<string, unknown> = {}) {
  const floor = slug === "leadership" ? "supervisor" : slug;
  return {
    id: `id-${slug}`,
    slug,
    title: `${slug} walkthrough`,
    min_role: floor,
    language: "en",
    content_status: "proposal",
    version: 1,
    duration_seconds: 300,
    video_path: `${slug}/en/v1/walkthrough.mp4`,
    captions_path: `${slug}/en/v1/captions.vtt`,
    poster_path: null,
    transcript_text: "First paragraph.\n\nSecond paragraph.",
    chapters: [
      { seconds: 0, title: "Clock in", status: "live" },
      { seconds: 90, title: "New job card", status: "proposal" },
      { seconds: 200, title: "Approvals", status: "mixed" },
    ],
    published_at: "2026-09-23T12:00:00Z",
    active: true,
    ...extra,
  };
}
const video = (slug: "installer" | "foreman" | "leadership") =>
  parseTrainingVideo(rawRow(slug)) as TrainingVideo;

describe("role floors", () => {
  it("ranks known roles and their legacy aliases, and nothing else", () => {
    expect(trainingRoleRank("installer")).toBe(0);
    expect(trainingRoleRank("lead")).toBe(1);
    expect(trainingRoleRank("admin")).toBe(2);
    expect(trainingRoleRank("big_boss")).toBe(3);
    // Unlike roleRank(), an unknown role is NOT the installer floor here.
    expect(trainingRoleRank("contractor")).toBeNull();
    expect(trainingRoleRank(null)).toBeNull();
    expect(trainingRoleRank(undefined)).toBeNull();
  });

  it.each([
    ["installer", ["installer"]],
    ["foreman", ["installer", "foreman"]],
    ["supervisor", ["installer", "foreman", "leadership"]],
    ["owner", ["installer", "foreman", "leadership"]],
    ["partner-ish unknown", []],
    [null, []],
  ])("%s sees %j", (role, want) => {
    const all = [video("leadership"), video("installer"), video("foreman")];
    expect(visibleTrainingVideos(all, role as string | null).map((v) => v.slug)).toEqual(want);
  });

  it("narrows by the previewed role — an owner viewing as installer sees the installer shelf only", () => {
    const serverAnswerForOwner = [video("installer"), video("foreman"), video("leadership")];
    expect(visibleTrainingVideos(serverAnswerForOwner, "installer").map((v) => v.slug)).toEqual(["installer"]);
  });

  it("can only hide: a preview role never shows more than the server returned", () => {
    expect(visibleTrainingVideos([video("installer")], "owner").map((v) => v.slug)).toEqual(["installer"]);
  });

  it("floors match the migration", () => {
    expect(canWatchFloor("installer", "installer")).toBe(true);
    expect(canWatchFloor("foreman", "installer")).toBe(false);
    expect(canWatchFloor("supervisor", "foreman")).toBe(false);
    expect(canWatchFloor("supervisor", "admin")).toBe(true);
  });
});

describe("parseTrainingVideo", () => {
  it("accepts a well-formed published row", () => {
    const v = video("foreman");
    expect(v).toMatchObject({ slug: "foreman", minRole: "foreman", language: "en", version: 1 });
    expect(v.chapters).toHaveLength(3);
  });

  it.each([
    ["floor that does not match its slug", { min_role: "installer" }],
    ["unknown slug", { slug: "crew" }],
    ["video outside its version folder", { video_path: "leadership/en/v1/walkthrough.mp4" }],
    ["traversal in a path", { video_path: "foreman/en/v1/../../leadership/en/v1/walkthrough.mp4" }],
    ["captions that are not WebVTT", { captions_path: "foreman/en/v1/captions.srt" }],
    ["a poster in another walkthrough", { poster_path: "leadership/en/v1/poster.jpg" }],
    ["switched off", { active: false }],
    ["not published", { published_at: null }],
    ["unknown language", { language: "fr" }],
    ["broken chapters", { chapters: [{ seconds: 5, title: "x", status: "live" }] }],
    ["zero duration", { duration_seconds: 0 }],
  ])("refuses a row with %s", (_why, extra) => {
    expect(parseTrainingVideo(rawRow("foreman", extra))).toBeNull();
  });

  it("reads any status that is not literally 'live' as a design preview", () => {
    expect(isDesignPreview(parseTrainingVideo(rawRow("installer"))!)).toBe(true);
    expect(isDesignPreview(parseTrainingVideo(rawRow("installer", { content_status: "draft" }))!)).toBe(true);
    expect(isDesignPreview(parseTrainingVideo(rawRow("installer", { content_status: "live" }))!)).toBe(false);
  });

  it("treats a blank transcript as none", () => {
    expect(parseTrainingVideo(rawRow("installer", { transcript_text: "  " }))!.transcript).toBeNull();
  });
});

describe("chapters", () => {
  const ok = [
    { seconds: 0, title: "A", status: "live" },
    { seconds: 30, title: " B ", status: "proposal" },
  ];
  it("accepts an ordered list inside the video, trimming titles", () => {
    expect(parseChapters(ok, 60)).toEqual([
      { seconds: 0, title: "A", status: "live" },
      { seconds: 30, title: "B", status: "proposal" },
    ]);
  });
  it.each([
    ["not an array", {}],
    ["empty", []],
    ["first not at zero", [{ seconds: 1, title: "A", status: "live" }]],
    ["past the end", [...ok, { seconds: 60, title: "C", status: "live" }]],
    ["out of order", [ok[0], { seconds: 30, title: "B", status: "live" }, { seconds: 20, title: "C", status: "live" }]],
    ["fractional seconds", [ok[0], { seconds: 2.5, title: "B", status: "live" }]],
    ["unknown status", [{ seconds: 0, title: "A", status: "shipped" }]],
    ["blank title", [{ seconds: 0, title: " ", status: "live" }]],
    ["too many", Array.from({ length: 61 }, (_, i) => ({ seconds: i, title: "x", status: "live" }))],
  ])("refuses %s", (_why, raw) => {
    expect(parseChapters(raw, 60)).toBeNull();
  });

  it("finds the chapter playing now", () => {
    const c = video("installer").chapters;
    expect(chapterIndexAt(c, 0)).toBe(0);
    expect(chapterIndexAt(c, 89.9)).toBe(0);
    expect(chapterIndexAt(c, 90)).toBe(1);
    expect(chapterIndexAt(c, 299)).toBe(2);
  });

  it("formats clock times", () => {
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(760)).toBe("12:40");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(-3)).toBe("0:00");
  });
});

describe("WebVTT and private media URLs", () => {
  it("recognises a WebVTT header", () => {
    expect(looksLikeWebVtt("WEBVTT\n\n00:00.000 --> 00:02.000\nHi")).toBe(true);
    expect(looksLikeWebVtt("﻿WEBVTT - Forge\r\n")).toBe(true);
    expect(looksLikeWebVtt("1\n00:00:00,000 --> 00:00:02,000\nHi")).toBe(false);
    expect(looksLikeWebVtt("<html>denied</html>")).toBe(false);
  });

  it("tells the service worker which URLs are private walkthrough media", () => {
    expect(
      isPrivateTrainingMediaUrl("https://x.supabase.co/storage/v1/object/sign/app-training/installer/en/v1/poster.jpg?token=abc"),
    ).toBe(true);
    expect(isPrivateTrainingMediaUrl("https://x.supabase.co/storage/v1/object/sign/app%2Dtraining/a.jpg")).toBe(true);
    expect(isPrivateTrainingMediaUrl("https://x.supabase.co/storage/v1/object/sign/photos/a.jpg?token=abc")).toBe(false);
    expect(isPrivateTrainingMediaUrl("https://example.com/app-training/a.jpg")).toBe(false);
  });
});

describe("listTrainingVideos", () => {
  let selectedCols: string | null;
  beforeEach(() => {
    selectedCols = null;
    fromSpy.mockReset();
    fromSpy.mockImplementation(() => {
      const chain = {
        select: (cols: string) => {
          selectedCols = cols;
          return chain;
        },
        eq: () => chain,
        order: () => Promise.resolve(selectResult.current),
      };
      return chain;
    });
  });

  it("names its columns (never *) and drops rows the screen cannot trust", async () => {
    selectResult.current = {
      data: [rawRow("installer"), rawRow("foreman", { min_role: "installer" }), { junk: true }],
      error: null,
    };
    const rows = await listTrainingVideos();
    expect(fromSpy).toHaveBeenCalledWith("app_training_videos");
    expect(selectedCols).toBe(TRAINING_VIDEO_COLS);
    expect(selectedCols).not.toContain("*");
    expect(rows.map((r) => r.slug)).toEqual(["installer"]);
  });

  it("answers an empty shelf when the table is not deployed yet", async () => {
    selectResult.current = { data: null, error: { code: "PGRST205", message: "Could not find the table 'public.app_training_videos'" } };
    await expect(listTrainingVideos()).resolves.toEqual([]);
  });

  it("surfaces any other failure so the screen can offer Retry", async () => {
    selectResult.current = { data: null, error: { code: "08006", message: "network" } };
    await expect(listTrainingVideos()).rejects.toMatchObject({ code: "08006" });
  });

  it("never writes", async () => {
    selectResult.current = { data: [rawRow("installer")], error: null };
    await listTrainingVideos();
    expect(rpcSpy).not.toHaveBeenCalled();
  });
});

describe("signTrainingMedia", () => {
  const created: string[] = [];
  const revoked: string[] = [];
  let signedWith: { paths: string[]; seconds: number } | null;
  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    signedWith = null;
    storageFromSpy.mockReset();
    storageFromSpy.mockImplementation((bucket: string) => {
      expect(bucket).toBe("app-training");
      return {
        createSignedUrls: (paths: string[], seconds: number) => {
          signedWith = { paths, seconds };
          return Promise.resolve(signResult.current);
        },
      };
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const u = `blob:captions-${created.length}`;
      created.push(u);
      return u;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u: string) => {
      revoked.push(u);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const v = () => video("installer");
  const signed = (paths: string[]) => paths.map((path) => ({ path, signedUrl: `https://s/${path}?token=t`, error: null }));

  it("signs every file for one hour and hands captions over as a blob", async () => {
    signResult.current = { data: signed(["installer/en/v1/walkthrough.mp4", "installer/en/v1/captions.vtt"]), error: null };
    const media = await signTrainingMedia(v(), async () => "WEBVTT\n\n00:00.000 --> 00:01.000\nHi");
    expect(signedWith).toEqual({ paths: ["installer/en/v1/walkthrough.mp4", "installer/en/v1/captions.vtt"], seconds: SIGNED_URL_SECONDS });
    expect(SIGNED_URL_SECONDS).toBe(3600);
    expect(media.videoUrl).toContain("walkthrough.mp4");
    expect(media.captionsUrl).toBe("blob:captions-0");
    expect(media.captionsFailed).toBe(false);
  });

  it("fails loudly when the video itself cannot be signed (not allowed, or gone)", async () => {
    signResult.current = {
      data: [{ path: "installer/en/v1/walkthrough.mp4", signedUrl: "", error: "Object not found" }],
      error: null,
    };
    await expect(signTrainingMedia(v(), async () => "WEBVTT")).rejects.toThrow();
  });

  it("fails when storage refuses the whole request", async () => {
    signResult.current = { data: null, error: { message: "signal lost" } };
    await expect(signTrainingMedia(v(), async () => "WEBVTT")).rejects.toMatchObject({ message: "signal lost" });
  });

  it("keeps the video when the captions fail, and says so", async () => {
    signResult.current = { data: signed(["installer/en/v1/walkthrough.mp4", "installer/en/v1/captions.vtt"]), error: null };
    const media = await signTrainingMedia(v(), async () => {
      throw new Error("offline");
    });
    expect(media.videoUrl).toBeTruthy();
    expect(media.captionsUrl).toBeNull();
    expect(media.captionsFailed).toBe(true);
  });

  it("refuses a caption file that is not WebVTT (an error page, say)", async () => {
    signResult.current = { data: signed(["installer/en/v1/walkthrough.mp4", "installer/en/v1/captions.vtt"]), error: null };
    const media = await signTrainingMedia(v(), async () => "<html>403</html>");
    expect(media.captionsFailed).toBe(true);
    expect(created).toEqual([]);
  });
});

describe("bounded signing and optional captions", () => {
  const created: string[] = [];
  const v = () => video("installer");
  const bothSigned = {
    data: ["installer/en/v1/walkthrough.mp4", "installer/en/v1/captions.vtt"].map((path) => ({
      path,
      signedUrl: `https://s/${path}?token=t`,
      error: null,
    })),
    error: null,
  };
  const never = () => new Promise<never>(() => {});
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let signImpl: () => Promise<unknown>;

  beforeEach(() => {
    created.length = 0;
    signImpl = async () => bothSigned;
    storageFromSpy.mockReset();
    storageFromSpy.mockImplementation(() => ({ createSignedUrls: () => signImpl() }));
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const u = `blob:c-${created.length}`;
      created.push(u);
      return u;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("gives up on a signing call that never answers, so the player can offer Retry", async () => {
    signImpl = never;
    await expect(signTrainingMedia(v(), async () => "WEBVTT\n", { signTimeoutMs: 20 })).rejects.toBeInstanceOf(
      TrainingTimeoutError,
    );
  });

  it("plays without captions when their headers never arrive, and aborts the download", async () => {
    let seen: AbortSignal | null = null;
    const media = await signTrainingMedia(
      v(),
      (_url, signal) => {
        seen = signal;
        return never(); // ignores its signal on purpose: the deadline must still hold
      },
      { captionsTimeoutMs: 20 },
    );
    expect(media.videoUrl).toContain("walkthrough.mp4");
    expect(media.captionsFailed).toBe(true);
    expect(media.captionsUrl).toBeNull();
    expect(seen!.aborted).toBe(true);
  });

  it("plays without captions when the body stalls after the headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("WEBVTT\n")) }), { status: 200 })),
    );
    const media = await signTrainingMedia(v(), (url, signal) => defaultFetchCaptions(url, signal), { captionsTimeoutMs: 30 });
    expect(media.captionsFailed).toBe(true);
    expect(created).toEqual([]);
  });

  it("asks the network with no-store and an abort signal", async () => {
    const fetchSpy = vi.fn(async () => new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nHi", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const controller = new AbortController();
    await expect(defaultFetchCaptions("https://s/c.vtt", controller.signal)).resolves.toMatch(/^WEBVTT/);
    expect(fetchSpy).toHaveBeenCalledWith("https://s/c.vtt", expect.objectContaining({ cache: "no-store", signal: controller.signal }));
  });

  it("refuses an oversized caption file, by header and by counting", async () => {
    expect(CAPTIONS_MAX_BYTES).toBe(1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("WEBVTT\n", { status: 200, headers: { "content-length": String(CAPTIONS_MAX_BYTES + 1) } })));
    await expect(defaultFetchCaptions("u", new AbortController().signal)).rejects.toThrow(/too large/);
    const big = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("WEBVTT\n"));
        c.enqueue(new Uint8Array(64));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(big, { status: 200 })));
    await expect(defaultFetchCaptions("u", new AbortController().signal, 32)).rejects.toThrow(/too large/);
    // And through the player path: the video still comes back.
    const media = await signTrainingMedia(v(), async () => "WEBVTT\n" + "x".repeat(40), { captionsMaxBytes: 32 });
    expect(media.captionsFailed).toBe(true);
    expect(media.videoUrl).toBeTruthy();
  });

  it("never makes a blob from captions that arrive after their deadline", async () => {
    const media = await signTrainingMedia(
      v(),
      async () => {
        await wait(60);
        return "WEBVTT\n\n00:00.000 --> 00:01.000\nLate";
      },
      { captionsTimeoutMs: 10 },
    );
    expect(media.captionsFailed).toBe(true);
    await wait(80);
    expect(created).toEqual([]);
  });

  it("stops at once when the player abandons it (account switch), with no blob", async () => {
    const controller = new AbortController();
    let captionSignal: AbortSignal | null = null;
    const run = signTrainingMedia(
      v(),
      (_u, signal) => {
        captionSignal = signal;
        return new Promise((resolve) => setTimeout(() => resolve("WEBVTT\n"), 50));
      },
      { signal: controller.signal },
    );
    await wait(5);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(captionSignal!.aborted).toBe(true);
    await wait(70);
    expect(created).toEqual([]);
  });

  it("clears its timers whichever way it ends", async () => {
    vi.useFakeTimers();
    await withDeadline(Promise.resolve(1), 1000, "x");
    await expect(withDeadline(Promise.reject(new Error("no")), 1000, "x")).rejects.toThrow("no");
    expect(vi.getTimerCount()).toBe(0);
    const pending = withDeadline(new Promise(() => {}), 1000, "x");
    vi.advanceTimersByTime(1000);
    await expect(pending).rejects.toBeInstanceOf(TrainingTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

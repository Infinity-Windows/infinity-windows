// The YouTube address parser: everything a supervisor will paste must
// resolve to the same embed player, and junk must not become an iframe.

import { describe, expect, it } from "vitest";
import {
  partitionLearningVideos,
  videoStatus,
  youtubeEmbedUrl,
  type LearningVideo,
} from "./learnVideos";

const EMBED = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";

describe("youtubeEmbedUrl", () => {
  it("accepts every common address shape", () => {
    expect(youtubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(EMBED);
    expect(youtubeEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(EMBED);
    expect(youtubeEmbedUrl("m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(EMBED);
  });

  it("rejects everything that is not a YouTube video", () => {
    expect(youtubeEmbedUrl("https://vimeo.com/12345")).toBeNull();
    expect(youtubeEmbedUrl("https://www.youtube.com/")).toBeNull();
    expect(youtubeEmbedUrl("not a url at all !!")).toBeNull();
    expect(youtubeEmbedUrl("")).toBeNull();
    // A hostile "id" can't smuggle a path into the iframe.
    expect(youtubeEmbedUrl("https://youtu.be/../evil")).toBeNull();
  });
});

// ------------------------------------------------------- wave U: draft or not

function video(over: Partial<LearningVideo> & { id: string }): LearningVideo {
  return {
    title: "Installing the XO slider",
    window_type_id: null,
    topic: null,
    video_path: null,
    youtube_url: "https://youtu.be/dQw4w9WgXcQ",
    summary: null,
    transcript: null,
    active: true,
    created_by: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    grants_clearance: null,
    ...over,
  };
}

describe("videoStatus", () => {
  it("reads a draft as a draft", () => {
    expect(videoStatus(video({ id: "a", status: "draft" }))).toBe("draft");
  });

  it("treats a database that has no status column yet as published", () => {
    // The frontend and the backend deploy separately, and the backend one has
    // silently failed before. A row with no status was visible to crews
    // yesterday and must stay visible today — the alternative is Learn going
    // blank on every phone in the field.
    expect(videoStatus(video({ id: "a" }))).toBe("published");
    expect(videoStatus(video({ id: "b", status: null }))).toBe("published");
    expect(videoStatus(video({ id: "c", status: "published" }))).toBe("published");
  });

  it("never reads an unknown value as a draft", () => {
    expect(videoStatus(video({ id: "a", status: "retired" }))).toBe("published");
  });
});

describe("partitionLearningVideos", () => {
  const rows = [
    video({ id: "pub", status: "published" }),
    video({ id: "draft", status: "draft" }),
    video({ id: "legacy" }),
  ];

  it("hides every draft from somebody who cannot author", () => {
    const { inbox, published } = partitionLearningVideos(rows, false);
    expect(inbox).toEqual([]);
    expect(published.map((v) => v.id)).toEqual(["pub", "legacy"]);
  });

  it("gives a supervisor an Inbox of drafts and the library beside it", () => {
    const { inbox, published } = partitionLearningVideos(rows, true);
    expect(inbox.map((v) => v.id)).toEqual(["draft"]);
    expect(published.map((v) => v.id)).toEqual(["pub", "legacy"]);
  });

  it("never lists the same video in both halves", () => {
    const { inbox, published } = partitionLearningVideos(rows, true);
    const both = inbox.filter((v) => published.some((p) => p.id === v.id));
    expect(both).toEqual([]);
  });

  it("keeps the order it was given", () => {
    const { published } = partitionLearningVideos(
      [video({ id: "b" }), video({ id: "a" })],
      true,
    );
    expect(published.map((v) => v.id)).toEqual(["b", "a"]);
  });
});

// The YouTube address parser: everything a supervisor will paste must
// resolve to the same embed player, and junk must not become an iframe.

import { describe, expect, it } from "vitest";
import { youtubeEmbedUrl } from "./learnVideos";

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

import { describe, expect, it } from "vitest";
import {
  deserializeUploadMeta,
  serializeUploadMeta,
  type QueuedUploadMeta,
} from "./queue";

const META: QueuedUploadMeta = {
  id: "b7a2f9c0-0000-4000-8000-000000000001",
  bucket: "install-media",
  path: "proj-1/W1/1720000000-memo.webm",
  contentType: "audio/webm",
  kind: "voice_memo",
  installEventId: "e1",
  windowId: "w1",
  createdBy: "installer@crew.com",
  createdAt: "2026-07-15T12:00:00.000Z",
};

describe("upload queue serialization", () => {
  it("round-trips metadata", () => {
    expect(deserializeUploadMeta(serializeUploadMeta(META))).toEqual(META);
  });

  it("round-trips null optional fields", () => {
    const meta = { ...META, installEventId: null, windowId: null, createdBy: null };
    expect(deserializeUploadMeta(serializeUploadMeta(meta))).toEqual(meta);
  });

  it("rejects corrupt JSON instead of throwing", () => {
    expect(deserializeUploadMeta("not json {")).toBeNull();
  });

  it("rejects records missing required fields", () => {
    expect(deserializeUploadMeta(JSON.stringify({ id: "x" }))).toBeNull();
  });

  it("rejects unknown buckets and kinds", () => {
    expect(
      deserializeUploadMeta(JSON.stringify({ ...META, bucket: "other" })),
    ).toBeNull();
    expect(
      deserializeUploadMeta(JSON.stringify({ ...META, kind: "document" })),
    ).toBeNull();
  });

  it("accepts the video kind", () => {
    expect(
      deserializeUploadMeta(JSON.stringify({ ...META, kind: "video" }))?.kind,
    ).toBe("video");
  });

  it("defaults createdAt when absent so old items still flush", () => {
    const { createdAt: _omitted, ...rest } = META;
    const out = deserializeUploadMeta(JSON.stringify(rest));
    expect(out).not.toBeNull();
    expect(typeof out!.createdAt).toBe("string");
  });
});

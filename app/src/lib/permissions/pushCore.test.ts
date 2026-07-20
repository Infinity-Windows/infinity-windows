import { describe, expect, it } from "vitest";
import {
  decidePushSubscribe,
  endpointsToPrune,
  isGoneStatus,
  subscriptionToPayload,
  urlBase64ToUint8Array,
  type PushEnvFacts,
} from "./pushCore";

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url deterministically to the exact bytes", () => {
    // "BAEC" (no padding needed) encodes the bytes [0x04, 0x01, 0x02] — the
    // 0x04 lead byte mirrors an uncompressed EC point's first byte.
    const out = urlBase64ToUint8Array("BAEC");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([0x04, 0x01, 0x02]);
  });

  it("handles base64url chars (- and _) and missing padding", () => {
    // "-_-_" is base64url for "+/+/", i.e. 3 bytes, and needs no padding.
    const out = urlBase64ToUint8Array("-_-_");
    expect(Array.from(out)).toEqual([0xfb, 0xff, 0xbf]);
  });
});

function facts(over: Partial<PushEnvFacts> = {}): PushEnvFacts {
  return {
    hasVapidKey: true,
    pushManagerSupported: true,
    secureContext: true,
    isIos: false,
    isStandalone: false,
    ...over,
  };
}

describe("decidePushSubscribe", () => {
  it("subscribes when everything is available", () => {
    expect(decidePushSubscribe(facts())).toEqual({ action: "subscribe", reason: "ok" });
  });

  it("skips (silently) on an insecure context", () => {
    expect(decidePushSubscribe(facts({ secureContext: false }))).toEqual({
      action: "skip",
      reason: "insecure",
    });
  });

  it("skips (silently) when PushManager is unsupported", () => {
    expect(decidePushSubscribe(facts({ pushManagerSupported: false }))).toEqual({
      action: "skip",
      reason: "unsupported",
    });
  });

  it("returns ios-not-installed on iOS Safari that isn't a home-screen PWA", () => {
    expect(
      decidePushSubscribe(facts({ isIos: true, isStandalone: false })),
    ).toEqual({ action: "skip", reason: "ios-not-installed" });
  });

  it("subscribes on iOS once installed to the home screen", () => {
    expect(
      decidePushSubscribe(facts({ isIos: true, isStandalone: true })),
    ).toEqual({ action: "subscribe", reason: "ok" });
  });

  it("skips (silently) when the VAPID public key is missing", () => {
    expect(decidePushSubscribe(facts({ hasVapidKey: false }))).toEqual({
      action: "skip",
      reason: "missing-key",
    });
  });

  it("prioritizes the iOS hint over a missing key so the user sees actionable advice", () => {
    expect(
      decidePushSubscribe(facts({ isIos: true, isStandalone: false, hasVapidKey: false })),
    ).toEqual({ action: "skip", reason: "ios-not-installed" });
  });
});

describe("subscriptionToPayload", () => {
  it("shapes a full subscription into a DB row", () => {
    expect(
      subscriptionToPayload(
        { endpoint: "https://push.example/abc", keys: { p256dh: "P", auth: "A" } },
        "TestUA/1.0",
      ),
    ).toEqual({
      endpoint: "https://push.example/abc",
      p256dh: "P",
      auth: "A",
      user_agent: "TestUA/1.0",
    });
  });

  it("defaults missing keys / user agent to null", () => {
    expect(subscriptionToPayload({ endpoint: "https://push.example/x" }, null)).toEqual({
      endpoint: "https://push.example/x",
      p256dh: null,
      auth: null,
      user_agent: null,
    });
  });

  it("returns null when there is no endpoint (nothing to store)", () => {
    expect(subscriptionToPayload({}, "UA")).toBeNull();
  });
});

describe("gone-subscription pruning", () => {
  it("treats 404 and 410 as gone, everything else as alive", () => {
    expect(isGoneStatus(404)).toBe(true);
    expect(isGoneStatus(410)).toBe(true);
    expect(isGoneStatus(201)).toBe(false);
    expect(isGoneStatus(429)).toBe(false);
    expect(isGoneStatus(500)).toBe(false);
  });

  it("returns only the gone endpoints to delete", () => {
    const pruned = endpointsToPrune([
      { endpoint: "alive", statusCode: 201 },
      { endpoint: "gone-404", statusCode: 404 },
      { endpoint: "gone-410", statusCode: 410 },
      { endpoint: "transient", statusCode: 500 },
    ]);
    expect(pruned).toEqual(["gone-404", "gone-410"]);
  });

  it("returns an empty list when nothing is gone", () => {
    expect(endpointsToPrune([{ endpoint: "a", statusCode: 201 }])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  decideInstallPrompt,
  detectIsIos,
  INSTALL_RE_SHOW_AFTER_MS,
  type InstallPromptFacts,
} from "./installCore";

function facts(over: Partial<InstallPromptFacts> = {}): InstallPromptFacts {
  return {
    isStandalone: false,
    isIos: false,
    canPromptNatively: false,
    dismissedAt: null,
    now: 1_000_000_000_000,
    ...over,
  };
}

describe("decideInstallPrompt", () => {
  it("shows the native prompt when a beforeinstallprompt was captured", () => {
    expect(decideInstallPrompt(facts({ canPromptNatively: true }))).toBe(
      "native",
    );
  });

  it("shows iOS steps for iOS Safari with no native prompt", () => {
    expect(decideInstallPrompt(facts({ isIos: true }))).toBe("ios");
  });

  it("prefers the native prompt over iOS steps when both apply", () => {
    expect(
      decideInstallPrompt(facts({ isIos: true, canPromptNatively: true })),
    ).toBe("native");
  });

  it("shows nothing on a desktop browser with no install support", () => {
    expect(decideInstallPrompt(facts())).toBe("none");
  });

  it("never shows when already running standalone", () => {
    expect(
      decideInstallPrompt(
        facts({ isStandalone: true, isIos: true, canPromptNatively: true }),
      ),
    ).toBe("none");
  });

  it("stays hidden while a recent dismissal is still in its quiet window", () => {
    const now = 2_000_000_000_000;
    expect(
      decideInstallPrompt(
        facts({ isIos: true, now, dismissedAt: now - 1000 }),
      ),
    ).toBe("none");
  });

  it("shows again once the dismissal quiet window has elapsed", () => {
    const now = 2_000_000_000_000;
    const dismissedAt = now - INSTALL_RE_SHOW_AFTER_MS - 1;
    expect(
      decideInstallPrompt(facts({ isIos: true, now, dismissedAt })),
    ).toBe("ios");
  });
});

describe("detectIsIos", () => {
  it("matches iPhone/iPad/iPod user agents", () => {
    expect(detectIsIos("iPhone", 5)).toBe(true);
    expect(detectIsIos("iPad", 5)).toBe(true);
    expect(detectIsIos("iPod", 0)).toBe(true);
  });

  it("detects iPadOS masquerading as macOS via touch points", () => {
    expect(detectIsIos("Macintosh", 5)).toBe(true);
    expect(detectIsIos("Macintosh", 0)).toBe(false);
  });

  it("rejects Android and desktop browsers", () => {
    expect(detectIsIos("Linux; Android 14", 5)).toBe(false);
    expect(detectIsIos("Windows NT 10.0", 0)).toBe(false);
  });
});

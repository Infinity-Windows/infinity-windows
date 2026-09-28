// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DESIGN_CACHE_KEY,
  dismissTryCard,
  normalizeDesign,
  readCachedDesign,
  resolveDesign,
  showTryCard,
  tryCardDismissed,
  writeCachedDesign,
} from "./design";

describe("resolveDesign (K-X2: person's choice, owner's master switch)", () => {
  it("renders the classic screens until anybody has chosen anything", () => {
    expect(resolveDesign({ personChoice: null, masterOn: null, cached: null })).toBe("classic");
  });

  it("follows the person's own choice either way", () => {
    expect(resolveDesign({ personChoice: "new", masterOn: true, cached: null })).toBe("new");
    expect(resolveDesign({ personChoice: "classic", masterOn: true, cached: "new" })).toBe(
      "classic",
    );
  });

  it("the owner's master switch OFF beats every choice — that is the rollback", () => {
    expect(resolveDesign({ personChoice: "new", masterOn: false, cached: "new" })).toBe(
      "classic",
    );
  });

  it("an unknown master switch (no signal, old database) does not bounce a person back", () => {
    expect(resolveDesign({ personChoice: "new", masterOn: null, cached: "new" })).toBe("new");
  });

  it("paints from the device cache before the profile answers, then the profile wins", () => {
    expect(resolveDesign({ personChoice: null, masterOn: null, cached: "new" })).toBe("new");
    expect(resolveDesign({ personChoice: "classic", masterOn: null, cached: "new" })).toBe(
      "classic",
    );
  });
});

describe("normalizeDesign", () => {
  it("accepts only the two words the database accepts", () => {
    expect(normalizeDesign("new")).toBe("new");
    expect(normalizeDesign("classic")).toBe("classic");
    expect(normalizeDesign("NEW")).toBe("classic");
    expect(normalizeDesign(undefined)).toBe("classic");
    expect(normalizeDesign(42)).toBe("classic");
  });
});

describe("device cache", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips and ignores junk", () => {
    expect(readCachedDesign()).toBeNull();
    writeCachedDesign("new");
    expect(readCachedDesign()).toBe("new");
    localStorage.setItem(DESIGN_CACHE_KEY, "garbage");
    expect(readCachedDesign()).toBeNull();
  });
});

describe("the one-time Try the new Forge card", () => {
  beforeEach(() => localStorage.clear());

  it("shows while the master switch is on and the person is still on classic", () => {
    expect(showTryCard({ masterOn: true, personChoice: null, dismissed: false })).toBe(true);
    expect(showTryCard({ masterOn: null, personChoice: "classic", dismissed: false })).toBe(true);
  });

  it("never shows once dismissed, once switched, or when the owner turned the release off", () => {
    expect(showTryCard({ masterOn: true, personChoice: null, dismissed: true })).toBe(false);
    expect(showTryCard({ masterOn: true, personChoice: "new", dismissed: false })).toBe(false);
    expect(showTryCard({ masterOn: false, personChoice: null, dismissed: false })).toBe(false);
  });

  it("dismissal is per person on the device", () => {
    dismissTryCard("u1");
    expect(tryCardDismissed("u1")).toBe(true);
    expect(tryCardDismissed("u2")).toBe(false);
  });
});

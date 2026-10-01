import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadPage } from "./reload";

describe("update reload diagnostics", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records why the page reloaded before navigation", () => {
    const reload = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    vi.stubGlobal("sessionStorage", { setItem });
    reloadPage("takeover-fallback");
    expect(setItem).toHaveBeenCalledWith("wops-update-reload-diagnostic", expect.stringContaining('"reason":"takeover-fallback"'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("still reloads when private browsing denies storage", () => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    vi.stubGlobal("sessionStorage", { setItem: () => { throw Error("denied"); } });
    expect(() => reloadPage()).not.toThrow();
    expect(reload).toHaveBeenCalledOnce();
  });
});

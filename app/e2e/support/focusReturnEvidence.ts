import type { Page, TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Observe the mounted provider's routing, without changing admission or making a read. */
export async function captureClockRouteEvidence(page: Page, profileId: string) {
  await page.evaluate(async owner => {
    // @ts-expect-error Vite serves the exact mounted application's module.
    const registry = await import("/src/lib/paidClock/flowRegistry.ts");
    const note = () => {
      try {
        const flow = registry.readClockFlow(owner);
        const key = "wops-e2e-clock-focus-evidence";
        const rows = JSON.parse(sessionStorage.getItem(key) || "[]") as unknown[];
        rows.push({ event: "clock-route", at: Date.now(), now: performance.now(),
          route: flow?.route ?? null, nativeRead: flow?.nativeRead ?? null,
          currentRead: flow?.currentRead ?? null, currentKind: flow?.current?.kind ?? null,
          dialogPresent: !!document.querySelector(".clock-sheet") });
        sessionStorage.setItem(key, JSON.stringify(rows.slice(-160)));
      } catch { /* Passive diagnostics must not affect clock behavior. */ }
    };
    registry.subscribeClockFlow(note); note();
  }, profileId);
}

/** Passive fixture evidence only: records focus and opener lifetime, never moves focus. */
export async function captureFocusReturnEvidence(page: Page) {
  await page.addInitScript(() => {
    const key = "wops-e2e-clock-focus-evidence", identities = new WeakMap<Node, number>();
    let next = 0, opener: HTMLElement | null = null, lastMutation = "";
    const describe = (node: EventTarget | null) => {
      if (!(node instanceof HTMLElement)) return null;
      if (!identities.has(node)) identities.set(node, ++next);
      return { identity: identities.get(node), tag: node.tagName, id: node.id, classes: node.className,
        label: node.getAttribute("aria-label"), text: node.textContent?.trim().slice(0, 120), connected: node.isConnected };
    };
    const note = (event: string, target: EventTarget | null) => {
      try {
        const rows = JSON.parse(sessionStorage.getItem(key) || "[]") as unknown[];
        rows.push({ event, at: Date.now(), now: performance.now(), target: describe(target),
          active: describe(document.activeElement), opener: describe(opener), documentFocused: document.hasFocus(),
          dialogPresent: !!document.querySelector(".clock-sheet") });
        sessionStorage.setItem(key, JSON.stringify(rows.slice(-160)));
      } catch { /* Diagnostics cannot affect the tested interaction. */ }
    };
    for (const event of ["focusin", "focusout", "keydown", "pointerdown"])
      document.addEventListener(event, e => {
        if (event === "keydown" && !["Escape", "Tab"].includes((e as KeyboardEvent).key)) return;
        if (event === "pointerdown" && e.target instanceof Element) {
          const button = e.target.closest("button");
          if (button?.textContent?.trim() === "Open my clock") opener = button;
        }
        note(event, e.target);
      }, true);
    for (const event of ["focus", "blur"]) window.addEventListener(event, e => note("window-" + event, e.target));
    document.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(() => {
        if (!opener) return;
        const state = `${opener.isConnected}:${!!document.querySelector(".clock-sheet")}:${identities.get(document.activeElement!) ?? 0}`;
        if (state !== lastMutation) { lastMutation = state; note("render", null); }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }, { once: true });
  });
  return async (info: TestInfo) => {
    const rows = await page.evaluate(() => JSON.parse(sessionStorage.getItem("wops-e2e-clock-focus-evidence") || "[]"))
      .catch((error: unknown) => ({ readError: String(error) }));
    const path = info.outputPath("clock-focus-evidence.json");
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(rows, null, 2));
    await info.attach("clock-focus-evidence.json", { path, contentType: "application/json" });
  };
}

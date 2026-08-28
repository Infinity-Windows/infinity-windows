// @vitest-environment happy-dom
//
// The boundary's job used to be only catching; the wave-M TDZ crash hid
// behind it for a whole wave. What this pins: a caught crash is REPORTED
// (reportCrash gets the error and the component stack), the screen shows a
// code the crew can read out loud, and Try again actually re-renders the
// children instead of forcing a full reload.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crashDigest } from "../lib/crashReport";
import { ErrorBoundary } from "./ErrorBoundary";

const reportCrash = vi.fn();
vi.mock("../lib/crashReport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crashReport")>();
  return { ...actual, reportCrash: (...args: unknown[]) => reportCrash(...args) };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  // React logs every caught render error in dev; keep the test output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const bomb = new Error("Cannot access 'jobCodeMap' before initialization");
let exploding = true;

function Bomb() {
  if (exploding) throw bomb;
  return <p>screen is back</p>;
}

function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
  });
  return host;
}

function click(el: HTMLElement, text: string) {
  const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!btn) throw new Error(`no button reading "${text}"`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("ErrorBoundary", () => {
  it("renders children untouched while nothing is wrong", () => {
    exploding = false;
    const el = mount();
    expect(el.textContent).toContain("screen is back");
    expect(reportCrash).not.toHaveBeenCalled();
  });

  it("reports a caught crash and shows the read-out-loud code", () => {
    exploding = true;
    const el = mount();
    expect(el.textContent).toContain("Something went wrong");
    expect(el.textContent).toContain(crashDigest(bomb));
    expect(reportCrash).toHaveBeenCalledTimes(1);
    const [error, componentStack] = reportCrash.mock.calls[0] as [Error, string];
    expect(error).toBe(bomb);
    expect(componentStack).toContain("Bomb");
  });

  it("Try again re-renders the children without a reload", () => {
    exploding = true;
    const el = mount();
    expect(el.textContent).toContain("Something went wrong");
    exploding = false;
    click(el, "Try again");
    expect(el.textContent).toContain("screen is back");
    expect(el.textContent).not.toContain("Something went wrong");
  });
});

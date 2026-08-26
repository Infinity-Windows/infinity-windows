// @vitest-environment happy-dom
//
// The one shared confirm card every permanent action uses now (ticket 22).
// The wording rule lives in the CALLERS (they pass "Delete forever"); this
// test only pins what the component itself always renders and wires up.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDanger } from "./ConfirmDanger";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: Partial<React.ComponentProps<typeof ConfirmDanger>> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ConfirmDanger
        confirmText="Delete forever"
        onConfirm={() => {}}
        onCancel={() => {}}
        {...props}
      >
        Permanently delete this thing? This can&rsquo;t be undone.
      </ConfirmDanger>,
    );
  });
  return host;
}

function click(el: HTMLElement, text: string) {
  const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!btn) throw new Error(`no button reading "${text}"`);
  act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("ConfirmDanger", () => {
  it("shows the plain-words body and always offers a Keep-it cancel", () => {
    const el = mount();
    expect(el.textContent).toContain("Permanently delete this thing?");
    expect(el.textContent).toContain("Keep it");
  });

  it("fires onConfirm from whatever label the caller passed", () => {
    const onConfirm = vi.fn();
    const el = mount({ confirmText: "Burning…", onConfirm });
    click(el, "Burning…");
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("fires onCancel from Keep it, never onConfirm", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const el = mount({ onConfirm, onCancel });
    click(el, "Keep it");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("disables the confirm button while pending, without hiding it", () => {
    const el = mount({ confirmText: "Deleting…", disabled: true });
    const btn = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Deleting…",
    );
    expect(btn?.disabled).toBe(true);
  });

  it("renders a footer under the confirm row when given one", () => {
    const el = mount({ footer: <p className="error">Refused — still in a job.</p> });
    expect(el.textContent).toContain("Refused — still in a job.");
  });
});

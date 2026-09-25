// @vitest-environment happy-dom
//
// The one line every clock surface draws for a punch that is still on the
// phone (K0.1): the tap time, and whether it is sending or waiting for
// signal; and, for a punch the phone gave up on, what it was, why, and the
// door to /stuck. Rendered for real and read back, in both languages.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageContext, type LanguageContextValue } from "../../lib/i18n/context";
import { CATALOG, translate, type Lang } from "../../lib/i18n";
import { tapTimeLabel } from "../../lib/clockQueueView";
import { ClockQueueStatus } from "./ClockQueueStatus";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

function mount(node: React.ReactNode, lang: Lang = "en"): HTMLElement {
  const value: LanguageContextValue = {
    lang,
    t: (key, vars) => translate(CATALOG, lang, key, vars),
    setLang: () => {},
    needsChoice: false,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <LanguageContext.Provider value={value}>
        <MemoryRouter>{node}</MemoryRouter>
      </LanguageContext.Provider>,
    );
  });
  return host;
}

const TAP = "2026-09-23T13:02:00.000Z";
const at = tapTimeLabel(TAP);

describe("the queued-punch line", () => {
  it("renders nothing when the server has everything", () => {
    const el = mount(<ClockQueueStatus pending={null} refused={[]} />);
    expect(el.querySelector(".clock-queue")).toBeNull();
  });

  it("says a clock-in is saved on this phone and sending, with its tap time", () => {
    const el = mount(
      <ClockQueueStatus pending={{ kind: "clock_in", entryId: "x", tappedAt: TAP, sending: false }} refused={[]} />,
    );
    expect(el.querySelector(".clock-queue-line")?.textContent).toBe(
      `Clocked in ${at} — saved on this phone, sending`,
    );
  });

  it("says it waits for signal when the phone has none", () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const el = mount(
      <ClockQueueStatus pending={{ kind: "clock_out", entryId: "o", tappedAt: TAP, sending: false }} refused={[]} />,
    );
    expect(el.querySelector(".clock-queue-line")?.textContent).toBe(
      `Clocked out ${at} — saved on this phone, sends when you have signal`,
    );
  });

  it("names a break start and a break end", () => {
    const el = mount(
      <>
        <ClockQueueStatus pending={{ kind: "break_start", entryId: "b", tappedAt: TAP, sending: true }} refused={[]} />
        <ClockQueueStatus pending={{ kind: "break_stop", entryId: "c", tappedAt: TAP, sending: false }} refused={[]} />
      </>,
    );
    const lines = [...el.querySelectorAll(".clock-queue-line")].map((n) => n.textContent);
    expect(lines).toEqual([
      `On break since ${at} — saved on this phone, sending`,
      `Back to work ${at} — saved on this phone, sending`,
    ]);
  });

  it("names a refused punch with its reason and links to Stuck writes", () => {
    const el = mount(
      <ClockQueueStatus
        pending={null}
        refused={[{ kind: "clock_in", entryId: "x", tappedAt: TAP, reason: "Sign today's toolbox talk first." }]}
      />,
    );
    const line = el.querySelector(".clock-queue-line.refused")!;
    expect(line.textContent).toContain(`Clock in at ${at} couldn't be sent: Sign today's toolbox talk first.`);
    expect(line.querySelector("a")?.getAttribute("href")).toBe("/stuck");
    expect(line.querySelector("a")?.textContent).toBe("See it under Stuck writes");
  });

  it("speaks Spanish", () => {
    const el = mount(
      <ClockQueueStatus pending={{ kind: "clock_in", entryId: "x", tappedAt: TAP, sending: false }} refused={[]} />,
      "es",
    );
    expect(el.querySelector(".clock-queue-line")?.textContent).toBe(
      `Entrada marcada a las ${at} — guardado en este teléfono, enviando`,
    );
  });
});

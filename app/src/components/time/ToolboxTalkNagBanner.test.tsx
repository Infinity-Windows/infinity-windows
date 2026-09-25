// @vitest-environment happy-dom
//
// The on-the-clock "today's toolbox talk is still due" nag reads today's
// signature through the same gate as everything else (offline toolbox
// signing, 2026-09-25), so nobody is nagged for a talk they signed in a dead
// zone that has not reached Forge yet.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/toolbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/toolbox")>();
  return { ...actual, myTodayCompletion: vi.fn(async () => null) };
});

import { ToolboxTalkNagBanner } from "./ToolboxTalkNagBanner";
import { discardFailed, enqueueToolboxSign, listAll } from "../../lib/offline/outbox";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  // A Wednesday morning: the nag is a weekday reminder.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 23, 9, 0));
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
});

afterEach(async () => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  for (const e of await listAll()) await discardFailed(e.id);
});

function mount(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(["toolboxToday", "me"], null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ToolboxTalkNagBanner profileId="me" clockedIn />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return host;
}

describe("the toolbox talk nag", () => {
  it("shows while today's talk is unsigned", () => {
    const el = mount();
    expect(el.textContent).toContain("Today's toolbox talk is still due");
  });

  it("goes away the moment the talk is signed on this phone, with no signal", async () => {
    const el = mount();
    await act(async () => {
      await enqueueToolboxSign(
        {
          clientId: "0e9b8c7d-3333-4c4d-8e5f-000000000077",
          profileId: "me",
          talkId: "t1",
          talkDate: "2026-09-23",
          typedName: "Dana",
          signedAt: new Date().toISOString(),
          talkSnapshot: "{}",
          signaturePath: "me/t1/sig.png",
          signatureDataUrl: "data:image/png;base64,iVBORw0KGgo=",
          pdfPath: null,
        },
        null,
      );
    });
    expect(el.textContent).not.toContain("Today's toolbox talk is still due");
  });
});

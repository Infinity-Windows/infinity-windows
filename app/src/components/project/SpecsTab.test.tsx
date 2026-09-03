// @vitest-environment happy-dom
//
// The tracking job's Plans & specs tab, mounted for real. It proves the slice's
// promise: a foreman can upload a raw planset that shows up with a view/download
// action, and that upload NEVER runs the opening/spec extraction pipeline a
// normal specs upload triggers (readScheduleFromDoc / runSpecExtraction /
// saveDraftOpenings stay untouched). An installer gets the read-only list with
// no upload affordance.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Planset } from "../../lib/install/types";

const {
  uploadSpy,
  signedUrlSpy,
  readScheduleSpy,
  runExtractionSpy,
  saveDraftsSpy,
  plansetsHolder,
} = vi.hoisted(() => {
  const plansetsHolder = { current: [] as Planset[] };
  return {
    plansetsHolder,
    uploadSpy: vi.fn(async (projectId: string, file: File, kind: string) => {
      const p = {
        id: `ps-${plansetsHolder.current.length}`,
        project_id: projectId,
        storage_path: `${projectId}/${Date.now()}-${file.name}`,
        source_format: "pdf",
        converted_pdf_path: null,
        page_count: null,
        status: "uploaded",
        kind,
        created_at: new Date().toISOString(),
      } as Planset;
      plansetsHolder.current = [p, ...plansetsHolder.current];
      return p;
    }),
    signedUrlSpy: vi.fn(async () => "https://example.test/signed.pdf"),
    readScheduleSpy: vi.fn(async () => ({ rows: [], source: "none", unreadPages: [] })),
    runExtractionSpy: vi.fn(async () => ({ saved: 0, pages: [], stopped: false })),
    saveDraftsSpy: vi.fn(async () => ({ inserted: 0, skipped: 0, unmatchedPlanMarks: [] })),
  };
});

// Only the three functions SpecsTab actually calls are real work; the rest are
// spies so the test can PROVE the extraction functions are never reached.
vi.mock("../../lib/install/api", () => ({
  listPlansets: vi.fn(async () => plansetsHolder.current),
  uploadPlanset: uploadSpy,
  getPlansetSignedUrl: signedUrlSpy,
  runSpecExtraction: runExtractionSpy,
  saveDraftOpenings: saveDraftsSpy,
  // useEffectiveRole reads this; the cache is seeded so it is never called, but
  // provide it so the query never trips on a missing fn.
  getRealProfile: vi.fn(async () => ({ id: "me", role: "foreman" })),
}));
vi.mock("../../lib/install/scheduleRead", () => ({
  readScheduleFromDoc: readScheduleSpy,
}));

import { SpecsTab } from "./SpecsTab";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let openSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  plansetsHolder.current = [];
  openSpy = vi.fn();
  window.open = openSpy as unknown as typeof window.open;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  uploadSpy.mockClear();
  signedUrlSpy.mockClear();
  readScheduleSpy.mockClear();
  runExtractionSpy.mockClear();
  saveDraftsSpy.mockClear();
});

const PROJECT = "p1";

function mount(role: string): HTMLElement {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        staleTime: 0,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
  // Seed the role so the foreman+ gate resolves synchronously.
  qc.setQueryData(["myRealProfile"], { id: "me", role, display_name: "Dana" });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={qc}>
        <SpecsTab projectId={PROJECT} />
      </QueryClientProvider>,
    );
  });
  return host;
}

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the tracking job Plans & specs tab", () => {
  it("invites a foreman to upload from the empty state", async () => {
    const el = mount("foreman");
    await flush();
    expect(el.textContent).toContain("No plans uploaded yet.");
    // The empty state carries the upload affordance.
    expect(el.querySelector('input[type="file"]')).toBeTruthy();
    expect(el.textContent).toContain("Upload plans");
  });

  it("shows an installer the read-only list — no upload affordance", async () => {
    const el = mount("installer");
    await flush();
    expect(el.querySelector('input[type="file"]')).toBeNull();
    expect(el.textContent).not.toContain("Upload plans");
  });

  it("uploads a raw planset WITHOUT running any extraction", async () => {
    const el = mount("foreman");
    await flush();

    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["%PDF-1.4 fake"], "site-plans.pdf", {
      type: "application/pdf",
    });
    await act(async () => {
      selectFile(input, file);
    });
    await flush();

    // uploadPlanset was called once, with the neutral "building" kind.
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0]).toEqual([PROJECT, file, "building"]);

    // The extraction pipeline is NEVER touched on a tracking upload.
    expect(readScheduleSpy).not.toHaveBeenCalled();
    expect(runExtractionSpy).not.toHaveBeenCalled();
    expect(saveDraftsSpy).not.toHaveBeenCalled();

    // The uploaded file now shows in the list with a view/download action.
    expect(el.textContent).toContain("site-plans.pdf");
    const openBtn = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.trim() === "Open",
    );
    expect(openBtn).toBeTruthy();

    // The action resolves a signed URL for view/download.
    await act(async () => {
      openBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(signedUrlSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalled();
  });

  it("uploads a whole bunch of plansets at once", async () => {
    const el = mount("foreman");
    await flush();

    const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [
      new File(["a"], "a.pdf", { type: "application/pdf" }),
      new File(["b"], "b.pdf", { type: "application/pdf" }),
      new File(["c"], "c.pdf", { type: "application/pdf" }),
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(uploadSpy).toHaveBeenCalledTimes(3);
    expect(el.textContent).toContain("a.pdf");
    expect(el.textContent).toContain("b.pdf");
    expect(el.textContent).toContain("c.pdf");
  });
});

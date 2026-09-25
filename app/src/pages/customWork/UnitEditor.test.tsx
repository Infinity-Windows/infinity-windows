// @vitest-environment happy-dom
//
// F1 (crew redesign K1.8): the unit form keeps what you type. The clock
// resolving a moment after the form opened used to remount the editor
// (its key carried the shift's job id) and wipe the typed values. Now the
// job arrives as a prop and fills a blank Job field on its own — and never
// overwrites one the person already chose.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  listProjectsAnyStatus: async () => [
    { id: "job-a", job_code: "A", name: "Job A", address: null, status: "active" },
    { id: "job-b", job_code: "B", name: "Job B", address: null, status: "active" },
  ],
}));
vi.mock("../../lib/install/api", () => ({ listProfiles: async () => [] }));

const { UnitEditor } = await import("./UnitEditor");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(jobId: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={qc}>
      <UnitEditor jobId={jobId} types={[]} busy={false} onSave={async () => {}} onCancel={() => {}} />
    </QueryClientProvider>
  );
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(tree));
  return host!;
}

/** Let the seeded project list land before touching the Job select. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function type(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("UnitEditor keeps what you type (F1)", () => {
  it("fills a blank Job when the shift resolves late, and keeps the typed name", async () => {
    const el = render(null);
    const name = el.querySelector<HTMLInputElement>('input[placeholder="e.g. 16"]')!;
    await act(async () => type(name, "16"));
    expect(name.value).toBe("16");
    // The clock resolves: the same mounted editor receives the job.
    render("job-a");
    await settle();
    expect(el.querySelector<HTMLInputElement>('input[placeholder="e.g. 16"]')!.value).toBe("16");
    expect(el.querySelector<HTMLSelectElement>("select")!.value).toBe("job-a");
  });

  it("never overwrites a job the person chose by hand", async () => {
    const el = render(null);
    await settle();
    const select = el.querySelector<HTMLSelectElement>("select")!;
    expect(select.querySelectorAll("option").length).toBeGreaterThan(1);
    await act(async () => type(select, "job-b"));
    expect(select.value).toBe("job-b");
    render("job-a");
    await settle();
    expect(el.querySelector<HTMLSelectElement>("select")!.value).toBe("job-b");
  });
});

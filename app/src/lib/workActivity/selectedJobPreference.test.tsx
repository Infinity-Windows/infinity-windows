// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSelectedJobPreference, type SelectedJobPreference } from "./selectedJobPreference";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root, latest: SelectedJobPreference;

function Harness({ ownerKey, authorized }: { ownerKey: string | null; authorized: readonly string[] | null }) {
  latest = useSelectedJobPreference(ownerKey, authorized);
  return null;
}
async function render(props: { ownerKey: string | null; authorized: readonly string[] | null }) {
  await act(async () => root.render(<Harness {...props} />));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useSelectedJobPreference", () => {
  it("starts with no pick — the scheduled recommendation is never implicit", async () => {
    await render({ ownerKey: "u1:1", authorized: null });
    expect(latest.jobId).toBeNull();
  });

  it("holds an explicit pick across later renders", async () => {
    await render({ ownerKey: "u1:1", authorized: null });
    await act(async () => latest.pick("job-1"));
    await render({ ownerKey: "u1:1", authorized: null });
    expect(latest.jobId).toBe("job-1");
  });

  it("is not overwritten by a later authorized read that still contains it", async () => {
    await render({ ownerKey: "u1:1", authorized: null });
    await act(async () => latest.pick("job-1"));
    await render({ ownerKey: "u1:1", authorized: ["job-1", "job-2"] });
    expect(latest.jobId).toBe("job-1");
  });

  it("clears when a fresh authorized read no longer contains the pick", async () => {
    await render({ ownerKey: "u1:1", authorized: null });
    await act(async () => latest.pick("job-1"));
    await render({ ownerKey: "u1:1", authorized: ["job-2"] });
    expect(latest.jobId).toBeNull();
  });

  it("clears on an identity change (sign-out / new login generation)", async () => {
    await render({ ownerKey: "u1:1", authorized: null });
    await act(async () => latest.pick("job-1"));
    await render({ ownerKey: "u1:2", authorized: null });
    expect(latest.jobId).toBeNull();
  });

  it("never picks without a known identity", async () => {
    await render({ ownerKey: null, authorized: null });
    await act(async () => latest.pick("job-1"));
    await render({ ownerKey: null, authorized: null });
    expect(latest.jobId).toBeNull();
  });

  it("clear() drops the pick explicitly", async () => {
    await render({ ownerKey: "u1:1", authorized: null });
    await act(async () => latest.pick("job-1"));
    await act(async () => latest.clear());
    await render({ ownerKey: "u1:1", authorized: null });
    expect(latest.jobId).toBeNull();
  });
});

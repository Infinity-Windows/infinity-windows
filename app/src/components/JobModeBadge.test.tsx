// @vitest-environment happy-dom
//
// The mode pill renders the right words for each combination. Mounted for real
// so it fails if the badge stops reading the catalog or the mode mapping drifts.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { JobModeBadge } from "./JobModeBadge";
import type { JobMode } from "../lib/types";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(allowed: JobMode[] | null | undefined): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<JobModeBadge allowed={allowed} />));
  return host.textContent ?? "";
}

describe("JobModeBadge", () => {
  it("labels a data job", () => {
    expect(render(["data"])).toBe("Data");
  });
  it("labels a tracking job", () => {
    expect(render(["tracking"])).toBe("Tracking");
  });
  it("labels a both-mode job", () => {
    expect(render(["data", "tracking"])).toBe("Data + Tracking");
  });
  it("falls back to Data when the modes are missing", () => {
    expect(render(undefined)).toBe("Data");
    expect(render(null)).toBe("Data");
  });
});

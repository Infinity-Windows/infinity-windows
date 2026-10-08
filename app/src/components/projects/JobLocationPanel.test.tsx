// @vitest-environment happy-dom
//
// The Job location card, mounted for real. What is worth proving: address and
// GPS each save on their own and can be cleared on purpose; 0,0 is a point and
// not "nothing"; a bad coordinate never reaches the server and is explained in
// the reader's language; a failed save keeps what was typed; a slow save can't
// be sent twice; an installer reads but never edits; and the snapshot the save
// compares against is the one taken when the editor OPENED, not whatever a
// background refetch hands the card later.
//
// Every network edge is mocked. The coordinate parser below is a stand-in that
// follows the contract in lib/jobLocation.ts (blank → both null; anything
// else malformed → coordinatesPair; outside ±90/±180 → coordinatesRange) so
// the card's handling of each answer can be pinned here; the parser itself is
// tested beside its own module.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../lib/types";

type Loc = { address: string | null; latitude: number | null; longitude: number | null };

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakeParse(raw: string): { latitude: number | null; longitude: number | null } {
  const s = raw.trim();
  if (!s) return { latitude: null, longitude: null };
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw coded("coordinatesPair");
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw coded("coordinatesPair");
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw coded("coordinatesRange");
  return { latitude, longitude };
}

const order: string[] = [];
const parseJobCoordinates = vi.fn(fakeParse);
const saveProjectLocation = vi.fn(async (..._a: unknown[]): Promise<void> => {});
const invalidateJobLocation = vi.fn(async (..._a: unknown[]) => {
  order.push("invalidate");
});
const toastSuccess = vi.fn((..._a: unknown[]) => {
  order.push("toast");
});
const pushToast = vi.fn();
const formatApiError = vi.fn((..._a: unknown[]) => "Couldn't reach the server. Try again.");
const directionsProps = vi.fn();

vi.mock("../../lib/jobLocation", () => ({
  parseJobCoordinates: (raw: string) => parseJobCoordinates(raw),
  saveProjectLocation: (...a: unknown[]) => saveProjectLocation(...a),
  invalidateJobLocation: (...a: unknown[]) => invalidateJobLocation(...a),
}));

vi.mock("../../lib/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/errors")>()),
  formatApiError: (...a: unknown[]) => formatApiError(...a),
}));

vi.mock("../../lib/toast", () => ({
  toastSuccess: (...a: unknown[]) => toastSuccess(...a),
  pushToast: (...a: unknown[]) => pushToast(...a),
  toastError: vi.fn(),
}));

vi.mock("../maps/DirectionsButton", () => ({
  DirectionsButton: (props: Record<string, unknown>) => {
    directionsProps(props);
    return <span data-testid="directions">{String(props.label ?? "")}</span>;
  },
}));

// The language provider's own dependencies.
vi.mock("../../lib/install/api", () => ({
  getRealProfile: vi.fn(async () => null),
  setMyLanguage: vi.fn(async () => {}),
}));

const { LanguageProvider } = await import("../../lib/i18n");
const { JobLocationPanel } = await import("./JobLocationPanel");

function project(loc: Partial<Loc> = {}): Project {
  return {
    id: "p1",
    job_code: "J-1",
    name: "Test job",
    status: "active",
    address: null,
    latitude: null,
    longitude: null,
    ...loc,
  } as unknown as Project;
}

let container: HTMLElement;
let root: Root;
let qc: QueryClient;

beforeEach(() => {
  localStorage.clear();
  order.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  parseJobCoordinates.mockReset().mockImplementation(fakeParse);
  saveProjectLocation.mockReset().mockResolvedValue(undefined);
  invalidateJobLocation.mockClear();
  toastSuccess.mockClear();
  pushToast.mockClear();
  formatApiError.mockClear();
  directionsProps.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function render(p: Project, isLead: boolean) {
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <LanguageProvider>
          <JobLocationPanel project={p} isLead={isLead} />
        </LanguageProvider>
      </QueryClientProvider>,
    );
  });
}

async function mount(p: Project, isLead = true) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(p, isLead);
  await flush();
}

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

async function tap(b: HTMLButtonElement | undefined) {
  expect(b).toBeDefined();
  act(() => {
    b!.click();
  });
  await flush();
}

const addressField = () =>
  container.querySelector<HTMLTextAreaElement>('textarea[name="job-location-address"]');
const gpsField = () => container.querySelector<HTMLInputElement>('input[name="job-location-gps"]');

/** Set a controlled field the way a keystroke does, so React sees it. */
function type(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(el).not.toBeNull();
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const EMPTY: Loc = { address: null, latitude: null, longitude: null };

describe("JobLocationPanel — reading", () => {
  it("an empty job explains itself and offers foreman+ a way to add one", async () => {
    await mount(project(), true);
    const text = container.textContent ?? "";
    expect(text).toContain("Job location");
    expect(text).toContain("No location saved for this job yet.");
    expect(text).toContain("Add an address, a GPS point, or both");
    expect(button("Add location")).toBeDefined();
    expect(directionsProps).not.toHaveBeenCalled();
  });

  it("an address-only job shows the address and routes directions to it", async () => {
    await mount(project({ address: "12 Main St\nLot 4" }), false);
    const text = container.textContent ?? "";
    expect(text).toContain("12 Main St");
    expect(text).toContain("No GPS point saved");
    expect(directionsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: "12 Main St\nLot 4", latitude: null, longitude: null }),
    );
  });

  it("a GPS-only job shows the point and hands it to directions without an address", async () => {
    await mount(project({ latitude: 40.7608, longitude: -111.891 }), false);
    const text = container.textContent ?? "";
    expect(text).toContain("40.7608, -111.891");
    expect(text).toContain("No address saved");
    expect(text).not.toContain("No location saved");
    expect(directionsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: null, latitude: 40.7608, longitude: -111.891 }),
    );
  });

  it("0, 0 is a real point, not an empty one", async () => {
    await mount(project({ latitude: 0, longitude: 0 }), false);
    const text = container.textContent ?? "";
    expect(text).toContain("0, 0");
    expect(text).not.toContain("No GPS point saved");
    expect(text).not.toContain("No location saved");
    expect(directionsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ latitude: 0, longitude: 0 }),
    );
  });

  it("with both, says directions go to the point and keeps the address as the label", async () => {
    await mount(project({ address: "12 Main St", latitude: 1.5, longitude: 2.5 }), false);
    expect(container.textContent).toContain("Directions go to the GPS point.");
    expect(directionsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ address: "12 Main St", latitude: 1.5, longitude: 2.5 }),
    );
  });

  it("an installer reads the location but gets no editor", async () => {
    await mount(project({ address: "12 Main St", latitude: 1, longitude: 2 }), false);
    expect(button("Edit location")).toBeUndefined();
    expect(button("Add location")).toBeUndefined();
    expect(addressField()).toBeNull();
    expect(container.textContent).toContain("12 Main St");
    expect(container.querySelector('[data-testid="directions"]')).not.toBeNull();
  });

  it("an installer on an empty job is told who can add it, with no button", async () => {
    await mount(project(), false);
    const text = container.textContent ?? "";
    expect(text).toContain("No location saved for this job yet.");
    expect(text).toContain("Ask a foreman or supervisor to add it.");
    expect(button("Add location")).toBeUndefined();
  });
});

describe("JobLocationPanel — editing", () => {
  it("saves an address alone, refetches before closing, then confirms", async () => {
    await mount(project(), true);
    await tap(button("Add location"));
    type(addressField(), "  12 Main St  ");
    await tap(button("Save location"));

    expect(saveProjectLocation).toHaveBeenCalledTimes(1);
    expect(saveProjectLocation).toHaveBeenCalledWith(
      "p1",
      { address: "12 Main St", latitude: null, longitude: null },
      EMPTY,
    );
    expect(invalidateJobLocation).toHaveBeenCalledWith(qc);
    expect(toastSuccess).toHaveBeenCalledWith("Location saved");
    expect(order).toEqual(["invalidate", "toast"]);
    expect(addressField()).toBeNull();
  });

  it("saves a GPS point alone", async () => {
    await mount(project(), true);
    await tap(button("Add location"));
    expect(container.textContent).toContain("Example: 40.7608, -111.8910");
    type(gpsField(), " 40.7608 , -111.8910 ");
    await tap(button("Save location"));

    expect(saveProjectLocation).toHaveBeenCalledWith(
      "p1",
      { address: null, latitude: 40.7608, longitude: -111.891 },
      EMPTY,
    );
  });

  it("saves 0, 0 as a point", async () => {
    await mount(project(), true);
    await tap(button("Add location"));
    type(gpsField(), "0, 0");
    await tap(button("Save location"));
    expect(saveProjectLocation).toHaveBeenCalledWith(
      "p1",
      { address: null, latitude: 0, longitude: 0 },
      EMPTY,
    );
  });

  it("clears both on purpose, comparing against what was there", async () => {
    const before = { address: "12 Main St", latitude: 0, longitude: -1.25 };
    await mount(project(before), true);
    await tap(button("Edit location"));
    expect(addressField()!.value).toBe("12 Main St");
    expect(gpsField()!.value).toBe("0, -1.25");

    await tap(button("Clear both"));
    expect(addressField()!.value).toBe("");
    expect(gpsField()!.value).toBe("");
    await tap(button("Save location"));

    expect(saveProjectLocation).toHaveBeenCalledWith("p1", EMPTY, before);
  });

  it.each([
    ["half a pair", "40.7608"],
    ["a trailing comma", "40.7608,"],
    ["words", "north, west"],
    ["no comma", "40.7608 -111.891"],
    ["three numbers", "1, 2, 3"],
    ["NaN", "NaN, 4"],
  ])("refuses %s with the pair message and keeps the draft", async (_label, raw) => {
    await mount(project(), true);
    await tap(button("Add location"));
    type(addressField(), "12 Main St");
    type(gpsField(), raw);
    await tap(button("Save location"));

    expect(saveProjectLocation).not.toHaveBeenCalled();
    expect(container.querySelector(".job-location-error")?.textContent).toBe(
      "Enter latitude and longitude as two numbers separated by a comma, like 40.7608, -111.8910.",
    );
    expect(gpsField()!.value).toBe(raw);
    expect(addressField()!.value).toBe("12 Main St");
  });

  it.each([
    ["latitude past 90", "90.0001, 0"],
    ["longitude past -180", "0, -180.5"],
  ])("refuses %s with the range message", async (_label, raw) => {
    await mount(project(), true);
    await tap(button("Add location"));
    type(gpsField(), raw);
    await tap(button("Save location"));

    expect(saveProjectLocation).not.toHaveBeenCalled();
    expect(container.querySelector(".job-location-error")?.textContent).toBe(
      "Latitude must be between -90 and 90, and longitude between -180 and 180.",
    );
    expect(gpsField()!.value).toBe(raw);
  });

  it("accepts the exact boundaries", async () => {
    await mount(project(), true);
    await tap(button("Add location"));
    type(gpsField(), "-90, 180");
    await tap(button("Save location"));
    expect(saveProjectLocation).toHaveBeenCalledWith(
      "p1",
      { address: null, latitude: -90, longitude: 180 },
      EMPTY,
    );
  });

  it("a failed save keeps the draft, shows a plain message, and retries", async () => {
    const offline = new TypeError("Failed to fetch");
    saveProjectLocation.mockRejectedValueOnce(offline).mockResolvedValueOnce(undefined);
    await mount(project(), true);
    await tap(button("Add location"));
    type(addressField(), "12 Main St");
    type(gpsField(), "1, 2");
    await tap(button("Save location"));

    expect(formatApiError).toHaveBeenCalledWith(offline);
    expect(container.querySelector(".job-location-error")?.textContent).toBe(
      "Couldn't reach the server. Try again.",
    );
    expect(container.textContent).not.toContain("Failed to fetch");
    expect(addressField()!.value).toBe("12 Main St");
    expect(gpsField()!.value).toBe("1, 2");
    expect(invalidateJobLocation).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();

    await tap(button("Save location"));
    expect(saveProjectLocation).toHaveBeenCalledTimes(2);
    expect(invalidateJobLocation).toHaveBeenCalledTimes(1);
    expect(addressField()).toBeNull();
  });

  it("while a save is in flight, a second tap sends nothing and Cancel is held", async () => {
    saveProjectLocation.mockImplementation(() => new Promise<void>(() => {}));
    await mount(project(), true);
    await tap(button("Add location"));
    type(addressField(), "12 Main St");

    const saveBtn = button("Save location")!;
    act(() => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(saveProjectLocation).toHaveBeenCalledTimes(1);
    const pending = button("Saving…");
    expect(pending?.disabled).toBe(true);
    expect(button("Cancel")?.disabled).toBe(true);
    expect(addressField()!.disabled).toBe(true);
    expect(gpsField()!.disabled).toBe(true);
    await tap(pending);
    expect(saveProjectLocation).toHaveBeenCalledTimes(1);
  });

  it("compares against the location as it was when the editor opened, through a refetch", async () => {
    const opened = { address: "Old Rd", latitude: 1, longitude: 2 };
    await mount(project(opened), true);
    await tap(button("Edit location"));
    type(addressField(), "My edit");

    // Someone else saved meanwhile and a background refetch hands the card the
    // newer row. The draft and the snapshot must both stay put.
    render(project({ address: "Their Rd", latitude: 3, longitude: 4 }), true);
    await flush();
    expect(addressField()!.value).toBe("My edit");
    expect(gpsField()!.value).toBe("1, 2");

    saveProjectLocation.mockRejectedValueOnce({ code: "P0001", message: "location changed" });
    await tap(button("Save location"));

    expect(saveProjectLocation).toHaveBeenCalledWith(
      "p1",
      { address: "My edit", latitude: 1, longitude: 2 },
      opened,
    );
    // The server's refusal is shown in plain words and the draft survives.
    expect(container.querySelector(".job-location-error")?.textContent).toBe(
      "Couldn't reach the server. Try again.",
    );
    expect(addressField()!.value).toBe("My edit");
  });

  it("Cancel closes without saving and the next open starts from the saved value", async () => {
    await mount(project({ address: "12 Main St" }), true);
    await tap(button("Edit location"));
    type(addressField(), "Scratch");
    await tap(button("Cancel"));
    expect(saveProjectLocation).not.toHaveBeenCalled();
    expect(addressField()).toBeNull();

    await tap(button("Edit location"));
    expect(addressField()!.value).toBe("12 Main St");
  });
});

describe("JobLocationPanel — Spanish", () => {
  it("speaks Spanish in the card, the editor and the coordinate errors", async () => {
    localStorage.setItem("infinity.language", "es");
    await mount(project(), true);
    let text = container.textContent ?? "";
    expect(text).toContain("Ubicación del trabajo");
    expect(text).toContain("Este trabajo todavía no tiene ubicación guardada.");

    await tap(button("Agregar ubicación"));
    text = container.textContent ?? "";
    expect(text).toContain("Coordenadas GPS");
    expect(text).toContain("Ejemplo: 40.7608, -111.8910");

    type(gpsField(), "95, 0");
    await tap(button("Guardar ubicación"));
    expect(container.querySelector(".job-location-error")?.textContent).toBe(
      "La latitud debe estar entre -90 y 90, y la longitud entre -180 y 180.",
    );
    expect(container.textContent).not.toContain("Latitude must be");

    type(gpsField(), "1, 2");
    await tap(button("Guardar ubicación"));
    expect(toastSuccess).toHaveBeenCalledWith("Ubicación guardada");
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStoredState } from "./useStoredState";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let seen: string[] = [];
let change: (next: string[] | ((old: string[]) => string[])) => void = () => undefined;

function Probe({ name, maxAgeMs }: { name: string; maxAgeMs?: number }) {
  const [value, set] = useStoredState<string[]>(name, [], { maxAgeMs });
  seen = value;
  change = set;
  return null;
}
const show = (name: string, maxAgeMs?: number) => act(() => { root.render(<Probe name={name} maxAgeMs={maxAgeMs} />); });
const remount = () => {
  act(() => root.unmount());
  root = createRoot(document.createElement("div"));
};

beforeEach(() => {
  localStorage.clear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

describe("useStoredState", () => {
  it("gives back what was chosen after a reload", () => {
    show("job-a");
    act(() => change(old => [...old, "1-19"]));
    expect(seen).toEqual(["1-19"]);
    remount();
    show("job-a");
    expect(seen).toEqual(["1-19"]);
  });

  it("keeps each key's value apart", () => {
    show("job-a");
    act(() => change(["1-19"]));
    show("job-b");
    expect(seen).toEqual([]);
    act(() => change(["2-1"]));
    show("job-a");
    expect(seen).toEqual(["1-19"]);
  });

  it("forgets a value that is too old", () => {
    vi.useFakeTimers();
    show("job-a", 60_000);
    act(() => change(["1-19"]));
    vi.advanceTimersByTime(61_000);
    remount();
    show("job-a", 60_000);
    expect(seen).toEqual([]);
  });
});

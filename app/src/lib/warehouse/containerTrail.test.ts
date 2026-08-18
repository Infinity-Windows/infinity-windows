import { describe, expect, it } from "vitest";
import { containerTrailLine } from "./containerTrail";
import type { ContainerMovementRow, StorageContainer } from "../storage";
import type { Location } from "../types";

const row = (over: Partial<ContainerMovementRow>): ContainerMovementRow => ({
  id: "m1",
  event: "moved",
  from_container_id: null,
  to_container_id: null,
  from_location_id: null,
  to_location_id: null,
  reason: null,
  actor: "someone",
  created_at: "2026-08-18T12:00:00Z",
  ...over,
});

const containers = new Map<string, StorageContainer>([
  ["conex-9", { id: "conex-9", name: "Conex 9" } as StorageContainer],
  ["truck-1", { id: "truck-1", name: "Flatbed" } as StorageContainer],
]);
const locations = new Map<string, Location>([
  ["yard-1", { id: "yard-1", address: "R-DOCK-A" } as Location],
]);

const text = (m: ContainerMovementRow) =>
  containerTrailLine(m, containers, locations).text;

describe("a container's trail reads as sentences", () => {
  it("an address change is already a sentence — the reason is the line", () => {
    expect(text(row({ reason: "address changed: Yard A → BLACK22" }))).toBe(
      "address changed: Yard A → BLACK22",
    );
  });

  it("a nesting move names both ends", () => {
    expect(text(row({ from_container_id: "conex-9", to_container_id: "truck-1" }))).toBe(
      "moved from Conex 9 to Flatbed",
    );
  });

  it("going into a box names the box", () => {
    expect(text(row({ to_container_id: "conex-9" }))).toBe("moved into Conex 9");
  });

  it("coming out reads as standing alone, not as a mystery", () => {
    expect(text(row({ from_container_id: "conex-9" }))).toBe(
      "taken out of Conex 9, on its own now",
    );
  });

  it("slots read by their printed address", () => {
    expect(text(row({ to_location_id: "yard-1" }))).toBe("moved into R-DOCK-A");
  });

  it("an id nothing can name still reads as words, never a uuid", () => {
    expect(text(row({ to_container_id: "gone" }))).toBe("moved into another container");
    // The raw-word history entries the audit flagged (F9) are the failure this
    // file exists to not repeat: no shape of row may surface as bare data.
    expect(text(row({}))).toBe("moved");
  });
});

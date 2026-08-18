import { describe, expect, it } from "vitest";
import { archiveBlockMessage, movedMessage } from "./ContainerDetail";

/**
 * Archiving a container is the one action on this page that cannot be undone
 * from inside the app: the container list only reads active rows, so an
 * archived conex leaves the grid, the poster runs and the sticker flows for
 * good. The block has to be specific — "you can't do that" tells a foreman
 * nothing, while "3 packages are still in Conex 7" tells them exactly what to
 * go move (warehouse ticket D5).
 */
describe("archiveBlockMessage", () => {
  it("names the count and the container, not a generic refusal", () => {
    expect(archiveBlockMessage("Conex 7", 3)).toBe(
      "3 packages are still in Conex 7. Move them out before you archive it.",
    );
  });

  it("reads right for a single package", () => {
    expect(archiveBlockMessage("Conex 7", 1)).toBe(
      "1 package is still in Conex 7. Move it out before you archive it.",
    );
  });

  it("lets an empty container through", () => {
    expect(archiveBlockMessage("Conex 7", 0)).toBeNull();
  });

  it("blocks while the count is unknown — empty and not-loaded-yet are not the same", () => {
    // The page reads `packages.data ?? []`, so a slow read and a failed read
    // both draw an empty manifest. If that reads as "0 packages", the one
    // action here nobody can undo fires on a conex that is actually full.
    expect(archiveBlockMessage("Conex 7", null)).toBe(
      "Still loading what is in Conex 7. Wait for the list before you archive it.",
    );
    // And it stays blocked even if the container list already came back.
    expect(archiveBlockMessage("Conex 7", null, [])).not.toBeNull();
  });

  it("also blocks a container that still holds another container", () => {
    // An empty crate inside a conex is still something inside it. Archiving
    // around it would leave the crate pointing at a parent nobody can open.
    expect(archiveBlockMessage("Conex 7", 0, ["Crate 4"])).toBe(
      "Conex 7 still holds Crate 4. Move it out before you archive it.",
    );
    expect(archiveBlockMessage("Conex 7", 0, ["Crate 4", "Crate 9"])).toBe(
      "Conex 7 still holds Crate 4 and Crate 9. Move them out before you archive it.",
    );
  });

  it("leads with the packages when there are both", () => {
    // The packages are the thing that actually gets lost, so they go first.
    expect(archiveBlockMessage("Conex 7", 2, ["Crate 4"])).toBe(
      "2 packages are still in Conex 7. Move them out before you archive it.",
    );
  });
});

/**
 * Moving a container is the one warehouse action a person takes with a forklift
 * rather than a phone, and the yard is exactly where the signal dies. The line
 * afterwards has to say where the container went AND, when there was no
 * signal, that the record of it is still sitting on the phone — otherwise the
 * next person to look at the grid sees the crate in its old spot and moves it
 * back (warehouse audit F3).
 */
describe("movedMessage", () => {
  it("names where it went and how many rode along", () => {
    expect(movedMessage("Conex 7", 3, false)).toBe(
      "Moved into Conex 7, 3 packages rode along",
    );
  });

  it("reads right for one package and for coming out on its own", () => {
    expect(movedMessage("Conex 7", 1, false)).toBe(
      "Moved into Conex 7, 1 package rode along",
    );
    expect(movedMessage(null, 2, false)).toBe(
      "Out on its own, 2 packages rode along",
    );
  });

  it("says so when the move is only on the phone", () => {
    expect(movedMessage("Conex 7", 3, true)).toBe(
      "Moved into Conex 7, 3 packages rode along — not sent yet, no signal in here.",
    );
  });
});

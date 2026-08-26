import { describe, expect, it } from "vitest";
import { openingStatusLabel, readyStatusLabel } from "./types";

describe("openingStatusLabel", () => {
  it("gives every OpeningStatus its plain word", () => {
    expect(openingStatusLabel("planned")).toBe("Planned");
    expect(openingStatusLabel("assigned")).toBe("Assigned");
    expect(openingStatusLabel("installed")).toBe("Installed");
  });

  it("falls back to the raw string for anything unknown, never undefined", () => {
    expect(openingStatusLabel("some_future_status")).toBe("some_future_status");
    expect(openingStatusLabel("")).toBe("");
  });
});

describe("readyStatusLabel", () => {
  it("gives every ReadyStatus its plain word", () => {
    expect(readyStatusLabel("ready")).toBe("Ready");
    expect(readyStatusLabel("blocked")).toBe("Blocked");
    // The one word this whole pick exists to retire: "incomplete" leaking
    // straight to a dispatch row read as a database column, not a sentence.
    expect(readyStatusLabel("incomplete")).toBe("Not ready yet");
  });

  it("falls back to the raw string for anything unknown, never undefined", () => {
    expect(readyStatusLabel("some_future_status")).toBe("some_future_status");
    expect(readyStatusLabel("")).toBe("");
  });
});

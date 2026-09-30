import { describe, expect, it } from "vitest";
import { commentaryEvent, readLiveEvent } from "./liveAskProtocol";

describe("GPT-Live delegation protocol", () => {
  it("reads the documented delegation and lifecycle events", () => {
    expect(readLiveEvent({ type: "session.started" })).toEqual({ kind: "started" });
    expect(readLiveEvent({ type: "session.delegation.created", delegation: { id: "task-1" } }))
      .toEqual({ kind: "delegation", delegationId: "task-1" });
    expect(readLiveEvent({ type: "session.closed", usage: { seconds: 12 } }))
      .toEqual({ kind: "closed", seconds: 12 });
  });

  it("does not treat a partial transcript delta as a complete Ask request", () => {
    expect(readLiveEvent({ type: "session.input_transcript.delta", delta: "Start unit", start_ms: 1000, end_ms: 1400 }))
      .toEqual({ kind: "other" });
  });

  it("sends the verified Ask result on the matching delegation", () => {
    expect(JSON.parse(commentaryEvent("task-1", "Window B14 is next."))).toEqual({
      type: "session.commentary.append", delegation_id: "task-1", content: "Window B14 is next.",
    });
  });
});

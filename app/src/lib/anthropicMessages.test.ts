import { describe, expect, it } from "vitest";
import { buildAnthropicMessages } from "../../../supabase/functions/_shared/knowledge";

// buildAnthropicMessages shapes a raw conversation history into the exact
// `messages` array the Anthropic Messages API accepts: user/assistant only,
// starting with a user turn, ending with the new user message.

describe("buildAnthropicMessages", () => {
  it("appends the final user message and keeps prior order", () => {
    const out = buildAnthropicMessages(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "how are you" },
        { role: "assistant", content: "good" },
      ],
      "what's next?",
    );
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how are you" },
      { role: "assistant", content: "good" },
      { role: "user", content: "what's next?" },
    ]);
  });

  it("drops leading assistant turns so it starts with a user turn", () => {
    const out = buildAnthropicMessages(
      [
        { role: "assistant", content: "greeting" },
        { role: "assistant", content: "another opener" },
        { role: "user", content: "actual question" },
        { role: "assistant", content: "answer" },
      ],
      "follow up",
    );
    expect(out[0]).toEqual({ role: "user", content: "actual question" });
    expect(out).toEqual([
      { role: "user", content: "actual question" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "follow up" },
    ]);
  });

  it("always starts with a user turn even when every history entry is assistant", () => {
    const out = buildAnthropicMessages(
      [
        { role: "assistant", content: "a" },
        { role: "assistant", content: "b" },
      ],
      "hello",
    );
    expect(out).toEqual([{ role: "user", content: "hello" }]);
  });

  it("filters out junk roles and empty/whitespace content", () => {
    const out = buildAnthropicMessages(
      [
        { role: "system", content: "you are a bot" },
        { role: "user", content: "" },
        { role: "user", content: "   " },
        { role: "tool", content: "noise" },
        { role: "user", content: "real question" },
        // deliberately malformed entries the runtime might hand us
        { role: "assistant", content: null as unknown as string },
        { role: "assistant", content: "real answer" },
      ],
      "final",
    );
    expect(out).toEqual([
      { role: "user", content: "real question" },
      { role: "assistant", content: "real answer" },
      { role: "user", content: "final" },
    ]);
  });

  it("handles an empty history by returning just the user message", () => {
    expect(buildAnthropicMessages([], "only question")).toEqual([
      { role: "user", content: "only question" },
    ]);
  });
});

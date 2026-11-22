import { requireOpenAI, type OpenAiUsage } from "./openai.ts";

import { CAD_VISION_MODEL } from "./cadReviewPrompt.mts";
export { CAD_VISION_MODEL };

// The model reasons before it answers and that comes out of max_output_tokens,
// so the effort is low and the allowance roomy. A failure carries the
// provider's own reason: on production (2026-11-22) every drawing came back
// as a bare 502 and nothing said why.
export async function requestCadVision(instructions: string, context: unknown, images: readonly string[]) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireOpenAI()}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: CAD_VISION_MODEL,
      store: false,
      instructions,
      reasoning: { effort: "low" },
      text: { format: { type: "json_object" } },
      max_output_tokens: 4096,
      input: [{
        role: "user",
        content: [
          // A json_object reply is refused unless the message itself says JSON.
          { type: "input_text", text: `Context, as JSON: ${JSON.stringify(context)}` },
          ...images.map(image_url => ({ type: "input_image", image_url, detail: "high" })),
        ],
      }],
    }),
  });
  if (!response.ok) {
    const said = (await response.json().catch(() => null))?.error?.message;
    return { status: response.status, text: null, usage: null,
      failure: `provider ${response.status}${typeof said === "string" ? `: ${said}` : ""}` };
  }
  const result = await response.json();
  const usage: OpenAiUsage | null = result.usage ? {
    inputTokens: result.usage.input_tokens ?? null,
    outputTokens: result.usage.output_tokens ?? null,
  } : null;
  const text = result.output?.flatMap((item: { content?: { type: string; text?: string }[] }) => item.content ?? [])
    .find((part: { type: string }) => part.type === "output_text")?.text;
  const answered = typeof text === "string";
  // A 200 with no answer: `incomplete_details.reason` is the provider's own
  // word for why (max_output_tokens, content_filter).
  const failure = answered ? null : `no answer, ${result.incomplete_details?.reason ?? result.status ?? "unknown"}`;
  return { status: response.status, text: answered ? text as string : null, usage, failure };
}
